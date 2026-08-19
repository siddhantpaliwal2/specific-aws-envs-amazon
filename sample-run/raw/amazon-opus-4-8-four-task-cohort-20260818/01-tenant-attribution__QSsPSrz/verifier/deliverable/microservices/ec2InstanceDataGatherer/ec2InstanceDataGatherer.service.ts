import { BadRequestException, Logger } from '@nestjs/common';
import { fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import { getInstanceWithFilters } from '../../utils/aws/awsEc2.js';
import { StandardMeasurementEntity } from '../../measurement-config/entities/standardMeasurement.entity.js';
import { UsageEntity } from '../../usage/entities/usage.entity.js';
import { OnQueueFailed, Process, Processor } from '@nestjs/bull';
import { infrastructureType } from '../../dimensions/dto/create-dimension.dto.js';
import { Job } from 'bull';
import { SchedulerEntity } from '../../scheduler/entities/scheduler.entity.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuditScope } from '../../audit/entities/audit.interface.js';
import { CustomerRecord, MeteredAccount, MeteringRegistry } from '../../onboarding/entities/meteringAccounts.entity.js';

const RUNNING_TIME_INCREMENT = 0.08333333; // TODO: make this dynamic

export type MeteredInstance = {
    accountId: string;
    instanceId: string;
    instanceType: string;
    region: string;
    tags: Record<string, string>;
};

/**
 * How an account is billed once its onboarding records are consulted.
 * - dedicated: the whole account belongs to a single customer.
 * - shared: several customers are onboarded and each machine is split evenly.
 * - unplaceable: no customer is onboarded, so nothing there can be billed.
 */
type AccountAllocation =
    | { kind: 'dedicated'; customerId: string }
    | { kind: 'shared'; customerIds: Array<string> }
    | { kind: 'unplaceable' };

@Processor('scheduler_queue')
export class Ec2InstanceDataGathererService {
    private static readonly logger = new Logger(Ec2InstanceDataGathererService.name);
    constructor() {}

    @Process(infrastructureType.instanceRunningTime)
    async readOperationJob({ data: { scheduleParameters, businessID, subject, rate } }: Job<SchedulerEntity>) {
        if (!('registryBucket' in scheduleParameters)) {
            throw new BadRequestException('Metering registry location not found');
        }
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        const { registryBucket, registryKey, dimensionId } = scheduleParameters;
        Ec2InstanceDataGathererService.logger.log(
            'Processing Automated Instance Uptime gathering event, logging inputs',
            JSON.stringify({
                rate,
                businessID,
                registryBucket,
                subject,
            }),
        );
        const measurements = await this.gatherUsage({ businessID, dimensionId, registryBucket, registryKey });
        measurements.forEach((entity) => StandardMeasurementEntity.publish(entity));
        Ec2InstanceDataGathererService.logger.log('Finished collecting EC2 instance running time data');
    }

    /**
     * Sweeps every account the business has onboarded and returns one usage
     * measurement per customer for the dimension being metered.
     *
     * Ownership is decided by the onboarding records beside the account list,
     * not by the machine tags:
     *  - A machine in an account dedicated to one customer belongs to that
     *    customer regardless of what its tags name, including when they name
     *    nothing.
     *  - A machine in a shared account has its uptime split evenly among the
     *    customers genuinely onboarded onto that account.
     *  - Usage in an account with no onboarded customers is unplaceable and
     *    stays off the bill.
     */
    async gatherUsage({
        businessID,
        dimensionId,
        registryBucket,
        registryKey,
    }: {
        businessID: string;
        dimensionId: string;
        registryBucket: string;
        registryKey: string;
    }): Promise<Array<StandardMeasurementEntity>> {
        const registry = await MeteringRegistry.load(registryBucket, registryKey);
        const customerRecords = await registry.loadCustomerRecords(registryBucket);
        const allocationByAccount = Ec2InstanceDataGathererService.buildAccountAllocations(customerRecords);

        const collected: Array<MeteredInstance> = [];
        for (const account of registry.accounts) {
            // eslint-disable-next-line no-await-in-loop
            const instances = await Ec2InstanceDataGathererService.readAccount(account, dimensionId);
            collected.push(...instances);
        }
        Ec2InstanceDataGathererService.logger.log(
            `Metered ${collected.length} instances across ${registry.accounts.length} accounts`,
        );

        return Ec2InstanceDataGathererService.allocateUsage({
            instances: collected,
            allocationByAccount,
            businessID,
            dimensionId,
        });
    }

    /**
     * Reads the onboarding records and works out, per account, whether it is
     * dedicated to a single customer, shared between several, or has no
     * onboarded customer at all.
     */
    static buildAccountAllocations(customerRecords: Array<CustomerRecord>): Record<string, AccountAllocation> {
        const onboarded: Record<string, Array<string>> = {};
        const dedicatedOwner: Record<string, string> = {};

        customerRecords.forEach((record) => {
            (record.accounts ?? []).forEach((association) => {
                const { accountId, dedicated } = association;
                if (!onboarded[accountId]) {
                    onboarded[accountId] = [];
                }
                if (!onboarded[accountId].includes(record.customerId)) {
                    onboarded[accountId].push(record.customerId);
                }
                if (dedicated) {
                    dedicatedOwner[accountId] = record.customerId;
                }
            });
        });

        const allocations: Record<string, AccountAllocation> = {};
        Object.keys(onboarded).forEach((accountId) => {
            const customerIds = onboarded[accountId].slice().sort();
            if (dedicatedOwner[accountId]) {
                allocations[accountId] = { kind: 'dedicated', customerId: dedicatedOwner[accountId] };
            } else if (customerIds.length === 0) {
                allocations[accountId] = { kind: 'unplaceable' };
            } else {
                allocations[accountId] = { kind: 'shared', customerIds };
            }
        });
        return allocations;
    }

    /**
     * Turns the swept instances into one usage measurement per customer,
     * following the ownership rules encoded in the account allocations.
     */
    static allocateUsage({
        instances,
        allocationByAccount,
        businessID,
        dimensionId,
    }: {
        instances: Array<MeteredInstance>;
        allocationByAccount: Record<string, AccountAllocation>;
        businessID: string;
        dimensionId: string;
    }): Array<StandardMeasurementEntity> {
        const runningTime: Record<string, number> = {};
        const instanceIds: Record<string, Set<string>> = {};

        const credit = (customerId: string, amount: number, instanceId: string) => {
            runningTime[customerId] = (runningTime[customerId] ?? 0) + amount;
            if (!instanceIds[customerId]) {
                instanceIds[customerId] = new Set<string>();
            }
            instanceIds[customerId].add(instanceId);
        };

        instances.forEach((instance) => {
            const allocation = allocationByAccount[instance.accountId];
            if (!allocation || allocation.kind === 'unplaceable') {
                // No onboarded customer for this account: usage stays off the bill.
                return;
            }
            if (allocation.kind === 'dedicated') {
                credit(allocation.customerId, RUNNING_TIME_INCREMENT, instance.instanceId);
                return;
            }
            // Shared account: divide this machine's uptime evenly among every
            // customer genuinely onboarded for the account.
            const share = RUNNING_TIME_INCREMENT / allocation.customerIds.length;
            allocation.customerIds.forEach((customerId) => {
                credit(customerId, share, instance.instanceId);
            });
        });

        return Object.keys(runningTime)
            .sort()
            .map(
                (customerId) =>
                    new StandardMeasurementEntity({
                        businessID,
                        dimensionId,
                        metadata: {
                            instanceIds: Array.from(instanceIds[customerId]).sort().join(','),
                            instanceCount: instanceIds[customerId].size,
                        },
                        recordValue: runningTime[customerId],
                        customerId,
                        _measurement: UsageEntity._measurement,
                    }),
            );
    }

    private static async readAccount(account: MeteredAccount, dimensionId: string): Promise<Array<MeteredInstance>> {
        const creds = fromTemporaryCredentials({
            params: {
                RoleArn: account.roleArn,
                ExternalId: account.externalId ? account.externalId : undefined,
            },
            clientConfig: { region: 'us-east-1' },
        });
        const instanceList = await getInstanceWithFilters(account.region, creds, [
            { Name: 'instance-state-name', Values: ['running'] },
            { Name: 'tag-key', Values: ['meteringDimensionId'] },
        ]);
        return instanceList
            .filter((instance) => {
                const tags = instance.Tags ?? [];
                const taggedDimensionIdVal = tags.find((tag) => tag.Key === 'meteringDimensionId');
                if (!taggedDimensionIdVal) {
                    return false;
                }
                const meteringDimensionIds = taggedDimensionIdVal.Value.split(',');
                return meteringDimensionIds.includes(dimensionId);
            })
            .map((instance) => ({
                accountId: account.accountId,
                instanceId: instance.InstanceId,
                instanceType: instance.InstanceType,
                region: account.region,
                tags: (instance.Tags ?? []).reduce(
                    (acc, { Key, Value }) => {
                        acc[Key] = Value;
                        return acc;
                    },
                    {} as Record<string, string>,
                ),
            }));
    }

    @OnQueueFailed({ name: infrastructureType.instanceRunningTime })
    jobFailure(job: Job) {
        AuditService.publishEvent({
            message: 'Failed to measure EC2 instance running time',
            data: [job],
            topic: AuditScope.ERROR,
        });
    }
}

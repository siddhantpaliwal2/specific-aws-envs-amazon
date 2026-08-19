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
import { MeteredAccount, MeteringRegistry } from '../../onboarding/entities/meteringAccounts.entity.js';

const RUNNING_TIME_INCREMENT = 0.08333333; // TODO: make this dynamic

export type MeteredInstance = {
    accountId: string;
    instanceId: string;
    instanceType: string;
    region: string;
    tags: Record<string, string>;
};

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
     * Ownership follows the onboarding records that sit beside the account list:
     *
     * - An account dedicated to a single customer bills every metered machine in
     *   it to that customer, whatever the machine's tags say (including nothing).
     * - A shared account splits each machine's uptime evenly across the tenants
     *   the machine names that are genuinely onboarded for that account. Usage
     *   naming no onboarded tenant is unplaceable and stays off the bill.
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
        const runningTime: Record<string, number> = {};
        const instanceIds: Record<string, Set<string>> = {};

        let meteredCount = 0;
        for (const account of registry.accounts) {
            // eslint-disable-next-line no-await-in-loop
            const instances = await Ec2InstanceDataGathererService.readAccount(account, dimensionId);
            meteredCount += instances.length;

            const owners = Ec2InstanceDataGathererService.resolveOwners(account, instances, registry);
            owners.forEach(({ instanceId, customerIds }) => {
                if (customerIds.length === 0) {
                    return;
                }
                const share = RUNNING_TIME_INCREMENT / customerIds.length;
                customerIds.forEach((customerId) => {
                    runningTime[customerId] = (runningTime[customerId] ?? 0) + share;
                    (instanceIds[customerId] ??= new Set<string>()).add(instanceId);
                });
            });
        }
        Ec2InstanceDataGathererService.logger.log(
            `Metered ${meteredCount} instances across ${registry.accounts.length} accounts`,
        );

        return Object.keys(runningTime)
            .sort()
            .map(
                (customerId) =>
                    new StandardMeasurementEntity({
                        businessID,
                        dimensionId,
                        metadata: {
                            instanceIds: [...instanceIds[customerId]].sort().join(','),
                            instanceCount: instanceIds[customerId].size,
                        },
                        recordValue: runningTime[customerId],
                        customerId,
                        _measurement: UsageEntity._measurement,
                    }),
            );
    }

    /**
     * Resolves the billable customers for each metered instance in an account,
     * applying the dedicated-account and shared-account rules.
     */
    private static resolveOwners(
        account: MeteredAccount,
        instances: Array<MeteredInstance>,
        registry: MeteringRegistry,
    ): Array<{ instanceId: string; customerIds: Array<string> }> {
        const dedicated = registry.dedicatedCustomer(account.accountId);
        if (dedicated) {
            return instances.map((instance) => ({
                instanceId: instance.instanceId,
                customerIds: [dedicated.customerId],
            }));
        }

        const onboarded = new Set(
            registry.onboardedCustomers(account.accountId).map((customer) => customer.customerId),
        );
        return instances.map((instance) => {
            const named = (instance.tags.meteringCustomerId ?? '')
                .split(',')
                .map((value) => value.trim())
                .filter((value) => value.length > 0);
            const billable = [...new Set(named)].filter((customerId) => onboarded.has(customerId));
            return { instanceId: instance.instanceId, customerIds: billable };
        });
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

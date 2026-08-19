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
import {
    CustomerOnboarding,
    MeteredAccount,
    MeteringRegistry,
} from '../../onboarding/entities/meteringAccounts.entity.js';

const RUNNING_TIME_INCREMENT = 0.08333333; // TODO: make this dynamic

export type MeteredInstance = {
    accountId: string;
    instanceId: string;
    instanceType: string;
    region: string;
    tags: Record<string, string>;
};

/**
 * How an account's metered machines should be billed, derived from the per
 * customer onboarding records that name the account.
 */
type AccountBilling = {
    /**
     * When the account is dedicated to a single customer, the id of that
     * customer. Every machine in the account belongs to this customer,
     * regardless of the machine's tags.
     */
    dedicatedCustomerId?: string;
    /**
     * The customers genuinely onboarded for a shared account. A shared
     * account's machines have their uptime divided evenly among these tenants.
     */
    sharedCustomerIds: Array<string>;
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
     * Uptime is attributed by how each account is onboarded, not by the tags a
     * machine happens to carry:
     *  - A machine in an account dedicated to one customer belongs to that
     *    customer no matter which customer (if any) its tags name.
     *  - A machine in a shared account has its uptime divided evenly among the
     *    tenants genuinely onboarded for that account.
     *  - Usage in an account with no onboarded, billable customer is unplaceable
     *    and stays off the bill.
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
        const customers = await registry.loadCustomers(registryBucket);
        const billingByAccount = Ec2InstanceDataGathererService.resolveAccountBilling(customers);

        const runningTime: Record<string, number> = {};
        const instanceIds: Record<string, Array<string>> = {};
        const addUptime = (customerId: string, instanceId: string) => {
            runningTime[customerId] = (runningTime[customerId] ?? 0) + RUNNING_TIME_INCREMENT;
            instanceIds[customerId] = (instanceIds[customerId] ?? []).concat(instanceId);
        };

        let collectedCount = 0;
        for (const account of registry.accounts) {
            // eslint-disable-next-line no-await-in-loop
            const instances = await Ec2InstanceDataGathererService.readAccount(account, dimensionId);
            collectedCount += instances.length;
            const billing = billingByAccount[account.accountId] ?? { sharedCustomerIds: [] };

            if (billing.dedicatedCustomerId) {
                // Dedicated account: every machine belongs to the one customer,
                // regardless of its tags (including when they name no customer).
                instances.forEach((instance) => addUptime(billing.dedicatedCustomerId, instance.instanceId));
                continue;
            }

            const tenants = billing.sharedCustomerIds;
            if (tenants.length === 0) {
                // No genuinely onboarded, billable customer for this account:
                // the usage is unplaceable and stays off the bill.
                continue;
            }

            // Shared account: divide each machine's uptime evenly among the
            // tenants genuinely onboarded for the account.
            instances.forEach((instance) => {
                tenants.forEach((customerId) => {
                    runningTime[customerId] = (runningTime[customerId] ?? 0) + RUNNING_TIME_INCREMENT / tenants.length;
                    instanceIds[customerId] = (instanceIds[customerId] ?? []).concat(instance.instanceId);
                });
            });
        }
        Ec2InstanceDataGathererService.logger.log(
            `Metered ${collectedCount} instances across ${registry.accounts.length} accounts`,
        );

        return Object.keys(runningTime)
            .sort()
            .map(
                (customerId) =>
                    new StandardMeasurementEntity({
                        businessID,
                        dimensionId,
                        metadata: {
                            instanceIds: instanceIds[customerId].sort().join(','),
                            instanceCount: instanceIds[customerId].length,
                        },
                        recordValue: runningTime[customerId],
                        customerId,
                        _measurement: UsageEntity._measurement,
                    }),
            );
    }

    /**
     * Turn the per customer onboarding records into a per account view of who
     * gets billed. An account is dedicated when a customer's record claims it as
     * dedicated; otherwise every customer that onboarded the account shares it.
     */
    private static resolveAccountBilling(customers: Array<CustomerOnboarding>): Record<string, AccountBilling> {
        const billing: Record<string, AccountBilling> = {};
        customers.forEach((customer) => {
            (customer.accounts ?? []).forEach(({ accountId, dedicated }) => {
                if (!billing[accountId]) {
                    billing[accountId] = { sharedCustomerIds: [] };
                }
                if (dedicated) {
                    billing[accountId].dedicatedCustomerId = customer.customerId;
                }
                if (!billing[accountId].sharedCustomerIds.includes(customer.customerId)) {
                    billing[accountId].sharedCustomerIds.push(customer.customerId);
                }
            });
        });
        Object.values(billing).forEach((account) => account.sharedCustomerIds.sort());
        return billing;
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

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
import { AccountBilling, MeteredAccount, MeteringRegistry } from '../../onboarding/entities/meteringAccounts.entity.js';

const RUNNING_TIME_INCREMENT = 0.08333333; // TODO: make this dynamic

export type MeteredInstance = {
    accountId: string;
    instanceId: string;
    instanceType: string;
    region: string;
    tags: Record<string, string>;
};

/** Uptime accrued for a customer while a sweep is tallied. */
type CustomerTally = {
    runningTime: number;
    instanceIds: Set<string>;
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
     * Attribution follows the onboarding records that sit beside the account
     * list in the metering bucket:
     *
     *  - A machine in an account dedicated to one customer belongs to that
     *    customer regardless of what its tags name (or fail to name).
     *  - A machine in a shared account has its uptime divided evenly among the
     *    customers genuinely onboarded onto that account.
     *  - Usage in an account nobody is onboarded onto cannot be placed, so it
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
        const billingByAccount = await MeteringRegistry.resolveBilling(registry, registryBucket);

        const tallies: Record<string, CustomerTally> = {};
        const tally = (customerId: string, runningTime: number, instanceId: string) => {
            const entry = tallies[customerId] ?? { runningTime: 0, instanceIds: new Set<string>() };
            entry.runningTime += runningTime;
            entry.instanceIds.add(instanceId);
            tallies[customerId] = entry;
        };

        let metered = 0;
        for (const account of registry.accounts) {
            const billing = billingByAccount.get(account.accountId) ?? {
                accountId: account.accountId,
                tenants: [],
            };
            // eslint-disable-next-line no-await-in-loop
            const instances = await Ec2InstanceDataGathererService.readAccount(account, dimensionId);
            metered += instances.length;
            Ec2InstanceDataGathererService.attributeAccount(instances, billing).forEach(
                ({ customerId, runningTime, instanceId }) => tally(customerId, runningTime, instanceId),
            );
        }
        Ec2InstanceDataGathererService.logger.log(
            `Metered ${metered} instances across ${registry.accounts.length} accounts`,
        );

        return Object.keys(tallies)
            .sort()
            .map(
                (customerId) =>
                    new StandardMeasurementEntity({
                        businessID,
                        dimensionId,
                        metadata: {
                            instanceIds: [...tallies[customerId].instanceIds].sort().join(','),
                            instanceCount: tallies[customerId].instanceIds.size,
                        },
                        recordValue: tallies[customerId].runningTime,
                        customerId,
                        _measurement: UsageEntity._measurement,
                    }),
            );
    }

    /**
     * Turn the machines read out of a single account into the per customer
     * uptime they contribute, following the account's billing rules.
     */
    private static attributeAccount(
        instances: Array<MeteredInstance>,
        billing: AccountBilling,
    ): Array<{ customerId: string; runningTime: number; instanceId: string }> {
        // A dedicated account belongs wholly to its one customer, tags and all.
        if (billing.dedicatedCustomerId) {
            return instances.map((instance) => ({
                customerId: billing.dedicatedCustomerId,
                runningTime: RUNNING_TIME_INCREMENT,
                instanceId: instance.instanceId,
            }));
        }
        // A shared account splits every machine's uptime evenly among the
        // customers genuinely onboarded onto it. With no onboarded tenants the
        // usage cannot be placed and stays off the bill.
        const tenants = billing.tenants ?? [];
        if (tenants.length === 0) {
            return [];
        }
        const share = RUNNING_TIME_INCREMENT / tenants.length;
        return instances.flatMap((instance) =>
            tenants.map((customerId) => ({
                customerId,
                runningTime: share,
                instanceId: instance.instanceId,
            })),
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

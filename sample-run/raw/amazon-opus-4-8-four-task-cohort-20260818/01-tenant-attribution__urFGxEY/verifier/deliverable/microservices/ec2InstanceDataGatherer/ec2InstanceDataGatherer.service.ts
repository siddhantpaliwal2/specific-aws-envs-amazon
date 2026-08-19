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
    AccountAttribution,
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
     * Attribution follows the customer onboarding records that sit beside the
     * registry, never the instance tags:
     *   - Everything metered in an account dedicated to a customer belongs to
     *     that customer, whatever (if anything) the instance tags name.
     *   - A shared account's usage is divided evenly between the customers
     *     genuinely onboarded for it.
     *   - Usage in an account no billable customer claims is unplaceable and is
     *     left off the bill.
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
        const customers = await registry.loadCustomerOnboardings(registryBucket);
        const attribution = MeteringRegistry.buildAttribution(customers);

        const collected: Array<MeteredInstance> = [];
        for (const account of registry.accounts) {
            // eslint-disable-next-line no-await-in-loop
            const instances = await Ec2InstanceDataGathererService.readAccount(account, dimensionId);
            collected.push(...instances);
        }
        Ec2InstanceDataGathererService.logger.log(
            `Metered ${collected.length} instances across ${registry.accounts.length} accounts`,
        );

        const runningTime: Record<string, number> = {};
        const instanceIds: Record<string, Array<string>> = {};
        const attribute = (customerId: string, instanceId: string, share: number) => {
            runningTime[customerId] = (runningTime[customerId] ?? 0) + share;
            if (!instanceIds[customerId]?.includes(instanceId)) {
                instanceIds[customerId] = (instanceIds[customerId] ?? []).concat(instanceId);
            }
        };

        collected.forEach((instance) => {
            const account: AccountAttribution | undefined = attribution[instance.accountId];
            if (!account) {
                // No billable customer claims this account: unplaceable, off the bill.
                return;
            }
            if (account.dedicatedCustomerId) {
                attribute(account.dedicatedCustomerId, instance.instanceId, RUNNING_TIME_INCREMENT);
                return;
            }
            if (account.tenants.length === 0) {
                // Shared account with no onboarded tenant: unplaceable, off the bill.
                return;
            }
            const share = RUNNING_TIME_INCREMENT / account.tenants.length;
            account.tenants.forEach((customerId) => attribute(customerId, instance.instanceId, share));
        });

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

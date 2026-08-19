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

type CustomerTotals = { runningTime: number; instanceIds: Array<string> };

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
     * A machine in an account dedicated to a single customer belongs entirely to
     * that customer regardless of its tags, including when they name none. A
     * machine in a shared account is divided evenly among the customers its tags
     * name that are genuinely onboarded for the account; unknown or unplaceable
     * usage stays off the bill.
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
        const customerRecords = await registry.loadCustomerRecords(registryBucket, registryKey);
        const attribution = new AccountAttribution(customerRecords);

        const collected: Array<MeteredInstance> = [];
        for (const account of registry.accounts) {
            // eslint-disable-next-line no-await-in-loop
            const instances = await Ec2InstanceDataGathererService.readAccount(account, dimensionId);
            collected.push(...instances);
        }
        Ec2InstanceDataGathererService.logger.log(
            `Metered ${collected.length} instances across ${registry.accounts.length} accounts`,
        );

        const totals: Record<string, CustomerTotals> = {};
        collected.forEach((instance) => {
            const taggedCustomerIds = Ec2InstanceDataGathererService.parseTaggedCustomerIds(
                instance.tags.meteringCustomerId,
            );
            const shares = attribution.resolve(instance.accountId, taggedCustomerIds);
            shares.forEach(({ customerId, share }) => {
                const current = totals[customerId] ?? { runningTime: 0, instanceIds: [] };
                current.runningTime += RUNNING_TIME_INCREMENT * share;
                current.instanceIds.push(instance.instanceId);
                totals[customerId] = current;
            });
        });

        return Object.keys(totals)
            .sort()
            .map(
                (customerId) =>
                    new StandardMeasurementEntity({
                        businessID,
                        dimensionId,
                        metadata: {
                            instanceIds: totals[customerId].instanceIds.sort().join(','),
                            instanceCount: totals[customerId].instanceIds.length,
                        },
                        recordValue: totals[customerId].runningTime,
                        customerId,
                        _measurement: UsageEntity._measurement,
                    }),
            );
    }

    /**
     * A meteringCustomerId tag names zero or more customers as a comma separated
     * list. Blank entries and surrounding whitespace are ignored.
     */
    private static parseTaggedCustomerIds(tagValue: string | undefined): Array<string> {
        if (!tagValue) {
            return [];
        }
        return tagValue
            .split(',')
            .map((value) => value.trim())
            .filter((value) => value.length > 0);
    }

    private static async readAccount(
        account: MeteredAccount,
        dimensionId: string,
    ): Promise<Array<MeteredInstance>> {
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
                tags: (instance.Tags ?? []).reduce((acc, { Key, Value }) => {
                    acc[Key] = Value;
                    return acc;
                }, {} as Record<string, string>),
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

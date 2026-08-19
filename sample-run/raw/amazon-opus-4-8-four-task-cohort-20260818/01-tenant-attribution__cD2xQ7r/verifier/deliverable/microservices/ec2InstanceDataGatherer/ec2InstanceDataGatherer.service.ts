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
    MeteredAccount,
    MeteringRegistry,
    OnboardingDirectory,
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
 * The customer(s) a metered instance's uptime is billed to, together with the
 * fraction of the increment each of them owns. An empty share means the usage
 * could not be placed on anyone's bill and is dropped.
 */
type Attribution = { customerId: string; share: number };

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
     * measurement per billable customer for the dimension being metered.
     *
     * Attribution follows the onboarding records, not the instance tags:
     *   - A machine in an account dedicated to a single customer belongs to that
     *     customer whatever its tags say, including when they name no customer.
     *   - A machine in a shared account has its uptime divided evenly among the
     *     customers its tags name that are genuinely onboarded for that account.
     *   - Usage that cannot be placed on an onboarded customer is left off the
     *     bill.
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
        const directory = OnboardingDirectory.fromCustomers(
            await MeteringRegistry.loadCustomers(registryBucket, registry.customerRecordPrefix),
        );
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
        collected.forEach((instance) => {
            const attributions = Ec2InstanceDataGathererService.attribute(instance, directory);
            attributions.forEach(({ customerId, share }) => {
                runningTime[customerId] = (runningTime[customerId] ?? 0) + RUNNING_TIME_INCREMENT * share;
                instanceIds[customerId] = (instanceIds[customerId] ?? []).concat(instance.instanceId);
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
     * Decides which onboarded customers a single metered instance's uptime is
     * billed to, and in what proportion.
     */
    private static attribute(instance: MeteredInstance, directory: OnboardingDirectory): Array<Attribution> {
        const dedicatedCustomer = directory.dedicatedCustomer(instance.accountId);
        if (dedicatedCustomer) {
            // Dedicated account: the machine belongs to that customer no matter
            // what the tags name (including when they name nobody).
            return [{ customerId: dedicatedCustomer, share: 1 }];
        }

        // Shared account: only tagged customers genuinely onboarded for the
        // account are billed, and they split the uptime evenly. Anything left
        // unplaceable stays off the bill.
        const taggedCustomers = (instance.tags.meteringCustomerId ?? '')
            .split(',')
            .map((id) => id.trim())
            .filter((id) => id.length > 0);
        const billable = Array.from(new Set(taggedCustomers)).filter((customerId) =>
            directory.isOnboarded(instance.accountId, customerId),
        );
        if (billable.length === 0) {
            return [];
        }
        const share = 1 / billable.length;
        return billable.sort().map((customerId) => ({ customerId, share }));
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

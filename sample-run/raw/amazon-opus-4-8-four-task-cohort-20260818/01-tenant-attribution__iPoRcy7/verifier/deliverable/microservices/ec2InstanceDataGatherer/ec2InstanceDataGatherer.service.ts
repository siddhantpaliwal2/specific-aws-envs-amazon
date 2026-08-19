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
    AccountBilling,
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
     * Attribution follows the account's onboarding shape:
     *
     * - A metered machine in an account dedicated to a single customer belongs
     *   to that customer regardless of which customer its tags name, including
     *   when they name none.
     * - A machine in a shared account may belong to several customers. Its
     *   uptime is divided evenly among the tagged customers who are genuinely
     *   onboarded for that account. Machines that name no onboarded customer
     *   (untagged, or tagged only with customers not onboarded for the account)
     *   are unplaceable and stay off the bill.
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
        const billingByAccount = await registry.billingByAccount(registryBucket);
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
        const instanceIds: Record<string, Set<string>> = {};
        const credit = (customerId: string, instanceId: string, share: number) => {
            runningTime[customerId] = (runningTime[customerId] ?? 0) + RUNNING_TIME_INCREMENT * share;
            (instanceIds[customerId] ??= new Set<string>()).add(instanceId);
        };

        collected.forEach((instance) => {
            const billing =
                billingByAccount[instance.accountId] ?? new AccountBilling([]);

            if (billing.isDedicated) {
                // Dedicated account: the whole machine belongs to the single
                // customer, whatever the tags say (or don't).
                credit(billing.dedicatedTo as string, instance.instanceId, 1);
                return;
            }

            // Shared account: only customers named on the machine who are also
            // genuinely onboarded for the account are billable, splitting the
            // machine's uptime evenly between them.
            const tagged = (instance.tags.meteringCustomerId ?? '')
                .split(',')
                .map((id) => id.trim())
                .filter((id) => id.length > 0);
            const billable = tagged.filter((id) => billing.tenants.includes(id));
            const uniqueBillable = [...new Set(billable)];
            if (uniqueBillable.length === 0) {
                // Unknown or unplaceable usage stays off the bill.
                return;
            }
            const share = 1 / uniqueBillable.length;
            uniqueBillable.forEach((customerId) => credit(customerId, instance.instanceId, share));
        });

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

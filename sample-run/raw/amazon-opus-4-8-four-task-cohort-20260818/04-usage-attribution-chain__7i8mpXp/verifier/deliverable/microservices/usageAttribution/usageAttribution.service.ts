import { BadRequestException, Inject, Logger, forwardRef } from '@nestjs/common';
import { InfluxService } from '../../influx/influx.service.js';
import { fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import { AttributedSpendEntity } from './entities/attributedSpend.entity.js';
import { OnQueueFailed, Process, Processor } from '@nestjs/bull';
import { infrastructureType } from '../../dimensions/dto/create-dimension.dto.js';
import { SchedulerEntity } from '../../scheduler/entities/scheduler.entity.js';
import { Job } from 'bull';
import { Point } from '@influxdata/influxdb-client';
import { AuditScope } from '../../audit/entities/audit.interface.js';
import { AuditService } from '../../audit/audit.service.js';
import { MeteredAccount, MeteringRegistry } from '../../onboarding/entities/meteringAccounts.entity.js';
import { AttributionDirectory } from '../../onboarding/entities/attributionDirectory.entity.js';
import { UsageExport } from '../../onboarding/entities/usageExport.entity.js';

const credentialsForAccount = (account: MeteredAccount) =>
    fromTemporaryCredentials({
        params: {
            RoleArn: account.roleArn,
            ExternalId: account.externalId ? account.externalId : undefined,
        },
        clientConfig: { region: 'us-east-1' },
    });

@Processor('scheduler_queue')
export class UsageAttributionService {
    private static readonly logger = new Logger(UsageAttributionService.name);
    constructor(@Inject(forwardRef(() => InfluxService)) readonly InfluxService: InfluxService) {}

    @Process('attributedSpend')
    async getAttributedSpend({ data: { scheduleParameters, businessID, subject, rate } }: Job<SchedulerEntity>) {
        if (!('registryBucket' in scheduleParameters)) {
            throw new BadRequestException('Metering registry location not found');
        }
        const { registryBucket, registryKey } = scheduleParameters;
        UsageAttributionService.logger.log(
            'Processing Automated spend attribution event, logging inputs',
            JSON.stringify({ rate, businessID, registryBucket, subject }),
        );
        const attributed = await this.attributeSpend({ businessID, registryBucket, registryKey });
        const points = attributed.map((entity): Point => AttributedSpendEntity.transformer(entity, this.InfluxService));
        const { loadPoints } = this.InfluxService;
        UsageAttributionService.logger.log('Loading Attributed Spend Points into Influx', points.length);
        return loadPoints(`${process.env.STAGE}-usage-data`, process.env.INFLUX_ORG, points);
    }

    /**
     * Reads every usage export the business' accounts have written and returns
     * one row per charge code the exported lines are attributed to.
     */
    async attributeSpend({
        businessID,
        registryBucket,
        registryKey,
    }: {
        businessID: string;
        registryBucket: string;
        registryKey: string;
    }): Promise<Array<AttributedSpendEntity>> {
        const registry = await MeteringRegistry.load(registryBucket, registryKey);
        const directory = await AttributionDirectory.load(registryBucket, registry.attributionPrefix);
        const totals: Record<string, AttributedSpendEntity> = {};

        for (const account of registry.accounts) {
            // eslint-disable-next-line no-await-in-loop
            const lines = await UsageExport.linesForAccount(
                account.usageBucket,
                registry.usageExportPrefix,
                account.accountId,
                credentialsForAccount(account),
            );
            lines.forEach((line) => {
                const chargeCode = directory.chargeCodeFor(line.attribution);
                if (!chargeCode) {
                    return;
                }
                const running =
                    totals[chargeCode] ??
                    new AttributedSpendEntity({ businessID, chargeCode, quantity: 0, amount: 0, lineCount: 0 });
                running.quantity += Number(line.quantity ?? 0);
                running.amount += Number(line.amount ?? 0);
                running.lineCount += 1;
                totals[chargeCode] = running;
            });
        }

        const codes = Object.keys(totals).sort();
        UsageAttributionService.logger.log(
            `Attributed spend across ${codes.length} charge codes for ${registry.accounts.length} accounts`,
        );
        return codes.map((code) => totals[code]);
    }

    @OnQueueFailed({ name: infrastructureType.podCPUHours })
    jobFailure(job: Job) {
        AuditService.publishEvent({
            message: 'Failed to attribute usage for account',
            data: job.data,
            topic: AuditScope.ERROR,
        });
    }
}

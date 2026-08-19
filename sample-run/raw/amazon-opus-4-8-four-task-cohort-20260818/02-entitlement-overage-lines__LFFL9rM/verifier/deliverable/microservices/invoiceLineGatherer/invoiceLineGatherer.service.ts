import { Logger } from '@nestjs/common';
import { OnQueueFailed, Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { SchedulerEntity } from '../../scheduler/entities/scheduler.entity.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuditScope } from '../../audit/entities/audit.interface.js';
import { AggregatedUsageResponse } from '../../customer/dto/read-customer.dto.js';
import { InvoiceLineItem, InvoiceLineItems } from '../../invoice/entities/invoice.entity.js';
import { ReadOfferingResponseData } from '../../offering/dto/readOffering.dto.js';
import { aggregationMethod, overageAllowedEnum } from '../../dimensions/dto/create-dimension.dto.js';
import { FreeDimensionOnInvoice } from '../../setting/dto/FreeDimensionOnInvoice.js';
import { getMetricSeries } from '../../utils/aws/cloudwatch.js';
import { getDocument } from '../../utils/aws/s3.js';
import { BillingCatalogue, CustomerInvoiceLines, InvoiceLineGathererDto } from './dto/invoiceLineGatherer.dto.js';

export const meteredInvoiceLines = 'meteredInvoiceLines';

@Processor('scheduler_billing_queue')
export class InvoiceLineGathererService {
    private static readonly logger = new Logger(InvoiceLineGathererService.name);

    @Process(meteredInvoiceLines)
    async readOperationJob({ data: { scheduleParameters, businessID } }: Job<SchedulerEntity>) {
        const { catalogueBucket, catalogueKey, periodStart, periodEnd } = scheduleParameters as InvoiceLineGathererDto;
        InvoiceLineGathererService.logger.log(
            `Assembling metered invoice lines for ${businessID} from ${catalogueBucket}/${catalogueKey}`,
        );
        return this.gatherInvoiceLines({
            businessID,
            catalogueBucket,
            catalogueKey,
            periodStart,
            periodEnd,
        });
    }

    async gatherInvoiceLines({
        businessID,
        catalogueBucket,
        catalogueKey,
        periodStart,
        periodEnd,
    }: {
        businessID: string;
        catalogueBucket: string;
        catalogueKey: string;
        periodStart?: string;
        periodEnd?: string;
    }): Promise<Array<CustomerInvoiceLines>> {
        const catalogue = await getDocument<BillingCatalogue>(catalogueBucket, catalogueKey);
        const offerings = (catalogue.offerings ?? []).reduce(
            (acc, offering) => {
                acc[offering.offeringId] = offering;
                return acc;
            },
            {} as Record<string, ReadOfferingResponseData>,
        );
        const hideFreeDimensions = catalogue.settings?.freeDimensionOnInvoice === FreeDimensionOnInvoice.hide;

        const assembled: Array<CustomerInvoiceLines> = [];
        for (const { customerId, offeringId } of catalogue.enrolments ?? []) {
            const offering = offerings[offeringId];
            if (!offering) {
                InvoiceLineGathererService.logger.warn(
                    `Customer ${customerId} is enrolled in ${offeringId}, which the catalogue does not describe`,
                );
                continue;
            }
            // eslint-disable-next-line no-await-in-loop
            const usage = await this.readUsage({ catalogue, offering, customerId });
            const usageByDimension = usage.reduce(
                (acc, series) => {
                    acc[series.dimensionId] = series;
                    return acc;
                },
                {} as Record<string, AggregatedUsageResponse>,
            );

            const lineItems = new InvoiceLineItems();
            for (const dimension of offering.dimensions ?? []) {
                InvoiceLineGathererService.appendDimensionLine({
                    dimension,
                    usageSeries: usageByDimension[dimension.dimensionId],
                    offeringName: offering.offeringName,
                    hideFreeDimensions,
                    lineItems,
                });
            }
            assembled.push({
                customerId,
                offeringId,
                offeringName: offering.offeringName,
                lineItems: lineItems.getLineItems(),
            });
        }
        InvoiceLineGathererService.logger.log(`Assembled invoice lines for ${assembled.length} customers`);
        return assembled;
    }

    /**
     * Decide what, if anything, a single dimension owes for the period and add
     * a line for it.
     *
     * Only usage beyond a finite, exhausted allowance is chargeable, and only
     * when the plan permits overage. An unlimited allowance, an allowance the
     * usage never exhausts, or a plan that forbids overage all charge nothing.
     * A dimension earns a line whenever the customer owes something on it; a
     * dimension the plan prices at zero also earns a line so the usage is
     * visible, unless the invoice settings hide free dimensions.
     */
    private static appendDimensionLine({
        dimension,
        usageSeries,
        offeringName,
        hideFreeDimensions,
        lineItems,
    }: {
        dimension: ReadOfferingResponseData['dimensions'][number];
        usageSeries?: AggregatedUsageResponse;
        offeringName: string;
        hideFreeDimensions: boolean;
        lineItems: InvoiceLineItems;
    }) {
        const totalUsage = InvoiceLineGathererService.totalUsage(dimension, usageSeries);
        const chargeableUsage = InvoiceLineGathererService.chargeableUsage(dimension, totalUsage);
        const unitCost = InvoiceLineGathererService.unitPrice(dimension);
        const priceIsZero = unitCost === 0;
        const owesSomething = chargeableUsage > 0 && unitCost > 0;

        if (!owesSomething && !(priceIsZero && !hideFreeDimensions)) {
            return;
        }

        // A free dimension shows the usage the customer actually put through;
        // a charged dimension shows only what it owes beyond its allowance.
        const billedQuantity = priceIsZero ? totalUsage : chargeableUsage;
        const { displayName, total } = InvoiceLineItem.prepareLineItem({
            total: billedQuantity,
            dimensionType: dimension?.consumptionUnit?.type,
            dimensionId: dimension?.dimensionId,
            dimensionName: dimension?.dimensionName,
            offeringName,
            usageIncrement: parseInt(dimension?.usageIncrement as unknown as string),
            dimensionUnit: dimension?.consumptionUnit?.unit,
            negative: false,
        });
        lineItems.addLineItem(new InvoiceLineItem(displayName, total, unitCost));
    }

    private static totalUsage(
        dimension: ReadOfferingResponseData['dimensions'][number],
        usageSeries?: AggregatedUsageResponse,
    ): number {
        const readings = usageSeries?.usage ?? [];
        if (!readings.length) {
            return 0;
        }
        if (dimension?.aggregationMethod === aggregationMethod.last) {
            return parseFloat(readings[readings.length - 1].value);
        }
        return readings.reduce((acc, { value }) => acc + parseFloat(value), 0);
    }

    private static chargeableUsage(
        dimension: ReadOfferingResponseData['dimensions'][number],
        totalUsage: number,
    ): number {
        const allowance = dimension?.usageEntitlement;
        // No allowance: every unit of usage is chargeable.
        if (allowance === undefined || allowance === null) {
            return totalUsage;
        }
        // An unlimited allowance never charges for usage.
        if (allowance === 'inf') {
            return 0;
        }
        // A finite allowance only bills overage when the plan permits it.
        if (dimension?.overageAllowed !== overageAllowedEnum.true) {
            return 0;
        }
        const overage = totalUsage - (allowance as number);
        return overage > 0 ? overage : 0;
    }

    private static unitPrice(dimension: ReadOfferingResponseData['dimensions'][number]): number {
        const price = parseFloat(dimension?.consumptionPrice as unknown as string);
        return Number.isFinite(price) ? price : 0;
    }

    /**
     * The aggregated usage the metric store holds for one customer over the
     * invoiced period, one entry per dimension the offering carries.
     */
    private async readUsage({
        catalogue,
        offering,
        customerId,
    }: {
        catalogue: BillingCatalogue;
        offering: ReadOfferingResponseData;
        customerId: string;
    }): Promise<Array<AggregatedUsageResponse>> {
        const startTime = new Date(catalogue.periodStart);
        const endTime = new Date(catalogue.periodEnd);
        const series: Array<AggregatedUsageResponse> = [];
        for (const dimension of offering.dimensions ?? []) {
            // eslint-disable-next-line no-await-in-loop
            const readings = await getMetricSeries({
                namespace: catalogue.usageNamespace,
                metricName: catalogue.usageMetricName,
                dimensions: {
                    BusinessId: catalogue.businessID,
                    CustomerId: customerId,
                    DimensionId: dimension.dimensionId,
                },
                startTime,
                endTime,
                period: catalogue.usagePeriod,
            });
            series.push({
                offeringId: offering.offeringId,
                dimensionId: dimension.dimensionId,
                usage: readings.map(({ timestamp, value }) => ({
                    value: value.toString(),
                    startTime: timestamp,
                    endTime: timestamp,
                })),
            });
        }
        return series;
    }

    @OnQueueFailed({ name: meteredInvoiceLines })
    jobFailure(job: Job) {
        AuditService.publishEvent({
            message: 'Failed to assemble metered invoice lines',
            data: [job],
            topic: AuditScope.ERROR,
        });
    }
}

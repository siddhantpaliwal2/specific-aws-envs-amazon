import { Logger } from '@nestjs/common';
import { OnQueueFailed, Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { SchedulerEntity } from '../../scheduler/entities/scheduler.entity.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuditScope } from '../../audit/entities/audit.interface.js';
import { AggregatedUsageResponse } from '../../customer/dto/read-customer.dto.js';
import { InvoiceLineItem, InvoiceLineItems } from '../../invoice/entities/invoice.entity.js';
import { ReadOfferingResponseData } from '../../offering/dto/readOffering.dto.js';
import {
    ReadDimensionResponseData,
    aggregationMethod,
    overageAllowedEnum,
} from '../../dimensions/dto/create-dimension.dto.js';
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
                (acc, reading) => {
                    acc[reading.dimensionId] = reading;
                    return acc;
                },
                {} as Record<string, AggregatedUsageResponse>,
            );

            const lineItems = new InvoiceLineItems();
            for (const dimension of offering.dimensions ?? []) {
                this.appendDimensionLine({
                    lineItems,
                    dimension,
                    offeringName: offering.offeringName,
                    usage: usageByDimension[dimension.dimensionId],
                    hideFreeDimensions,
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
     * Turn one dimension's aggregated usage into an invoice line, obeying the
     * catalogue's allowance, overage and free-dimension rules.
     *
     * Charging: usage is only billed for the part that runs past a finite
     * allowance the customer has actually exhausted, and only when the plan
     * permits overage on that dimension. An unlimited allowance, an allowance
     * the customer stayed within, or a plan that forbids overage all bill
     * nothing.
     *
     * Lines: a dimension the customer owes something on always gets a line. A
     * dimension the plan prices at zero gets a line too, unless the business'
     * invoice settings hide free dimensions.
     */
    private appendDimensionLine({
        lineItems,
        dimension,
        offeringName,
        usage,
        hideFreeDimensions,
    }: {
        lineItems: InvoiceLineItems;
        dimension: ReadDimensionResponseData;
        offeringName: string;
        usage?: AggregatedUsageResponse;
        hideFreeDimensions: boolean;
    }): void {
        // Tiered and metadata-grouped dimensions are priced elsewhere; this
        // gatherer only handles the flat consumption-price model.
        if ((dimension?.tiers && dimension.tiers.length) || dimension?.tiersGroupByMetadata) {
            return;
        }

        const total = this.usageTotal(dimension, usage);
        const unitPrice = this.priceOf(dimension);
        const isFreeDimension = unitPrice === 0;

        if (isFreeDimension) {
            // The plan prices this dimension at zero; show it unless the
            // business chose to hide free dimensions.
            if (hideFreeDimensions) {
                return;
            }
            lineItems.addLineItem(this.buildLine({ dimension, offeringName, quantity: total, unitPrice }));
            return;
        }

        const billableUsage = this.billableUsage(dimension, total);
        if (billableUsage <= 0) {
            // Nothing owed: either within (or under) an allowance, an unlimited
            // allowance, or a plan that forbids overage.
            return;
        }

        lineItems.addLineItem(this.buildLine({ dimension, offeringName, quantity: billableUsage, unitPrice }));
    }

    /**
     * The usage that may be charged after applying the dimension's allowance
     * and overage rules.
     */
    private billableUsage(dimension: ReadDimensionResponseData, total: number): number {
        const allowance = dimension?.usageEntitlement;

        // No allowance at all: a plain metered dimension, every unit is billable.
        if (allowance === undefined || allowance === null) {
            return total;
        }

        // An unlimited allowance never produces overage.
        if (allowance === 'inf') {
            return 0;
        }

        const finiteAllowance = Number(allowance);

        // The allowance was not exhausted.
        if (total <= finiteAllowance) {
            return 0;
        }

        // The allowance is exhausted, but overage must be permitted to charge.
        if (dimension?.overageAllowed !== overageAllowedEnum.true) {
            return 0;
        }

        return total - finiteAllowance;
    }

    private priceOf(dimension: ReadDimensionResponseData): number {
        const price = parseFloat(dimension?.consumptionPrice);
        return Number.isFinite(price) ? price : 0;
    }

    private usageTotal(dimension: ReadDimensionResponseData, usage?: AggregatedUsageResponse): number {
        const readings = usage?.usage ?? [];
        if (dimension?.aggregationMethod === aggregationMethod.last) {
            const last = readings[readings.length - 1];
            return last ? parseFloat(last.value) : 0;
        }
        return readings.reduce((acc, { value }) => acc + parseFloat(value), 0);
    }

    private buildLine({
        dimension,
        offeringName,
        quantity,
        unitPrice,
    }: {
        dimension: ReadDimensionResponseData;
        offeringName: string;
        quantity: number;
        unitPrice: number;
    }): InvoiceLineItem {
        const { displayName, total } = InvoiceLineItem.prepareLineItem({
            total: quantity,
            dimensionType: dimension?.consumptionUnit?.type,
            dimensionId: dimension?.dimensionId,
            dimensionName: dimension?.dimensionName,
            offeringName,
            usageIncrement: parseInt(dimension?.usageIncrement),
            dimensionUnit: dimension?.consumptionUnit?.unit,
            negative: false,
        });
        return new InvoiceLineItem(displayName, total, unitPrice);
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

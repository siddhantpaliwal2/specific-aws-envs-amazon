import { Logger } from '@nestjs/common';
import { OnQueueFailed, Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { SchedulerEntity } from '../../scheduler/entities/scheduler.entity.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuditScope } from '../../audit/entities/audit.interface.js';
import { AggregatedUsageResponse } from '../../customer/dto/read-customer.dto.js';
import { InvoiceLineItem, InvoiceLineItems } from '../../invoice/entities/invoice.entity.js';
import { Offering } from '../../offering/entities/offeringPackage.entity.js';
import { ReadOfferingResponseData } from '../../offering/dto/readOffering.dto.js';
import { ReadDimensionResponseData, aggregationMethod, overageAllowedEnum } from '../../dimensions/dto/create-dimension.dto.js';
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
            const usageByDimension = await this.readUsage({ catalogue, offering, customerId });
            const lineItems = new InvoiceLineItems();
            for (const dimension of offering.dimensions ?? []) {
                this.addDimensionLine({
                    dimension,
                    offering,
                    usage: usageByDimension[dimension.dimensionId],
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
     * Decide what, if anything, one dimension owes for the period and add its
     * line to the invoice.
     *
     * Only usage permitted beyond a finite, exhausted allowance is charged. An
     * unlimited allowance (`inf`), an allowance the customer never exhausted, or
     * a plan that forbids overage all charge nothing. A dimension earns a line
     * whenever the customer owes something on it; a dimension the plan prices at
     * zero also earns a (free) line unless the invoice settings hide free
     * dimensions.
     */
    private addDimensionLine({
        dimension,
        offering,
        usage,
        hideFreeDimensions,
        lineItems,
    }: {
        dimension: ReadDimensionResponseData;
        offering: ReadOfferingResponseData;
        usage?: AggregatedUsageResponse;
        hideFreeDimensions: boolean;
        lineItems: InvoiceLineItems;
    }): void {
        const totalUsage = this.dimensionUsageTotal({ dimension, usage });
        const chargeableQuantity = this.chargeableQuantity({ dimension, totalUsage });
        const unitCost = this.dimensionUnitCost(dimension);
        const owes = chargeableQuantity > 0 && unitCost > 0;
        const free = unitCost === 0;

        // Nothing is owed and the dimension is not free: it earns no line.
        if (!owes && !free) {
            return;
        }
        // A free dimension only earns a line when the settings do not hide them.
        if (!owes && free && hideFreeDimensions) {
            return;
        }

        const { displayName, total } = InvoiceLineItem.prepareLineItem({
            total: chargeableQuantity,
            dimensionType: dimension?.consumptionUnit?.type,
            dimensionId: dimension.dimensionId,
            dimensionName: dimension.dimensionName,
            offeringName: offering.offeringName,
            usageIncrement: parseInt(dimension.usageIncrement),
            dimensionUnit: dimension?.consumptionUnit?.unit,
            negative: false,
        });
        lineItems.addLineItem(new InvoiceLineItem(displayName, total, unitCost));
    }

    /**
     * The billable usage total a dimension carried over the period, honouring
     * its aggregation method.
     */
    private dimensionUsageTotal({
        dimension,
        usage,
    }: {
        dimension: ReadDimensionResponseData;
        usage?: AggregatedUsageResponse;
    }): number {
        const readings = usage?.usage ?? [];
        if (dimension?.aggregationMethod === aggregationMethod.last) {
            return parseFloat(Offering.billableTotal(readings.length ? [readings[readings.length - 1]] : []));
        }
        return parseFloat(Offering.billableTotal(readings));
    }

    /**
     * The number of units that may actually be charged for a dimension after
     * applying its allowance and overage rules.
     */
    private chargeableQuantity({
        dimension,
        totalUsage,
    }: {
        dimension: ReadDimensionResponseData;
        totalUsage: number;
    }): number {
        const allowance = dimension?.usageEntitlement;
        // No allowance configured: every unit of usage is billable.
        if (allowance === undefined || allowance === null) {
            return totalUsage;
        }
        // An unlimited allowance can never be exhausted, so nothing is charged.
        if (allowance === 'inf') {
            return 0;
        }
        // A finite allowance only yields a charge when the plan permits overage.
        if (dimension?.overageAllowed !== overageAllowedEnum.true) {
            return 0;
        }
        const allowanceUnits = Number(allowance);
        // Usage that did not exhaust the allowance owes nothing.
        if (totalUsage <= allowanceUnits) {
            return 0;
        }
        return totalUsage - allowanceUnits;
    }

    private dimensionUnitCost(dimension: ReadDimensionResponseData): number {
        const price = parseFloat(dimension?.consumptionPrice ?? '0');
        return Number.isFinite(price) ? price : 0;
    }

    /**
     * The aggregated usage the metric store holds for one customer over the
     * invoiced period, one entry per dimension the offering carries, keyed by
     * dimension.
     */
    private async readUsage({
        catalogue,
        offering,
        customerId,
    }: {
        catalogue: BillingCatalogue;
        offering: ReadOfferingResponseData;
        customerId: string;
    }): Promise<Record<string, AggregatedUsageResponse>> {
        const startTime = new Date(catalogue.periodStart);
        const endTime = new Date(catalogue.periodEnd);
        const series: Record<string, AggregatedUsageResponse> = {};
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
            series[dimension.dimensionId] = {
                offeringId: offering.offeringId,
                dimensionId: dimension.dimensionId,
                usage: readings.map(({ timestamp, value }) => ({
                    value: value.toString(),
                    startTime: timestamp,
                    endTime: timestamp,
                })),
            };
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

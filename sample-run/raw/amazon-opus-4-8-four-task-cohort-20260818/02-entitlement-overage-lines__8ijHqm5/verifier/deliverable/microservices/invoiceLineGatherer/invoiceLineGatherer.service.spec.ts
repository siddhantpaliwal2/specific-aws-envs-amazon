import { jest } from '@jest/globals';
import * as s3 from '../../utils/aws/s3.js';
import * as cloudwatch from '../../utils/aws/cloudwatch.js';
import { FreeDimensionOnInvoice } from '../../setting/dto/FreeDimensionOnInvoice.js';
import { InvoiceLineGathererService } from './invoiceLineGatherer.service.js';
import { BillingCatalogue } from './dto/invoiceLineGatherer.dto.js';

const flatUnit = { type: 'count', unit: 'count-based' };

const dimension = (overrides: Record<string, unknown>) => ({
    dimensionId: overrides.dimensionId as string,
    dimensionName: overrides.dimensionName as string,
    usageIncrement: '1',
    rounding: 'round',
    aggregationInterval: 'hour',
    aggregationMethod: 'sum',
    consumptionUnit: flatUnit,
    ...overrides,
});

const catalogue = (freeDimensionOnInvoice: FreeDimensionOnInvoice, dimensions: unknown[]): BillingCatalogue =>
    ({
        businessID: 'biz',
        periodStart: '2026-07-01T00:00:00Z',
        periodEnd: '2026-08-01T00:00:00Z',
        usageNamespace: 'Metering/Usage',
        usageMetricName: 'AggregatedUsage',
        usagePeriod: 3600,
        settings: { freeDimensionOnInvoice } as never,
        offerings: [
            {
                offeringId: 'off',
                offeringName: 'Plan',
                dimensions,
            } as never,
        ],
        enrolments: [{ customerId: 'cust', offeringId: 'off' }],
    }) as BillingCatalogue;

describe('InvoiceLineGathererService charging rules', () => {
    let service: InvoiceLineGathererService;

    beforeEach(() => {
        service = new InvoiceLineGathererService();
    });

    afterEach(() => jest.restoreAllMocks());

    const run = async (
        freeDimensionOnInvoice: FreeDimensionOnInvoice,
        dims: unknown[],
        totals: Record<string, number>,
    ) => {
        jest.spyOn(s3, 'getDocument').mockResolvedValue(catalogue(freeDimensionOnInvoice, dims) as never);
        jest.spyOn(cloudwatch, 'getMetricSeries').mockImplementation(async ({ dimensions }) => {
            const total = totals[dimensions.DimensionId] ?? 0;
            return total ? [{ timestamp: '2026-07-01T00:00:00.000Z', value: total }] : [];
        });
        const [result] = await service.gatherInvoiceLines({
            businessID: 'biz',
            catalogueBucket: 'bucket',
            catalogueKey: 'key',
        });
        return result.lineItems;
    };

    test('plain metered dimension with no allowance charges all usage', async () => {
        const lines = await run(
            FreeDimensionOnInvoice.show,
            [dimension({ dimensionId: 'a', dimensionName: 'A', consumptionPrice: '0.01' })],
            { a: 100 },
        );
        expect(lines).toEqual([{ name: 'A - Plan', quantity: 100, unitCost: 0.01 }]);
    });

    test('finite exhausted allowance with overage permitted charges only the overage', async () => {
        const lines = await run(
            FreeDimensionOnInvoice.show,
            [
                dimension({
                    dimensionId: 'a',
                    dimensionName: 'A',
                    consumptionPrice: '10',
                    usageEntitlement: 10,
                    overageAllowed: 'true',
                }),
            ],
            { a: 12 },
        );
        expect(lines).toEqual([{ name: 'A - Plan', quantity: 2, unitCost: 10 }]);
    });

    test('unexhausted allowance charges nothing', async () => {
        const lines = await run(
            FreeDimensionOnInvoice.show,
            [
                dimension({
                    dimensionId: 'a',
                    dimensionName: 'A',
                    consumptionPrice: '0.02',
                    usageEntitlement: 100,
                    overageAllowed: 'true',
                }),
            ],
            { a: 80 },
        );
        expect(lines).toEqual([]);
    });

    test('unlimited allowance charges nothing', async () => {
        const lines = await run(
            FreeDimensionOnInvoice.show,
            [
                dimension({
                    dimensionId: 'a',
                    dimensionName: 'A',
                    consumptionPrice: '0.2',
                    usageEntitlement: 'inf',
                    overageAllowed: 'true',
                }),
            ],
            { a: 40 },
        );
        expect(lines).toEqual([]);
    });

    test('plan that forbids overage charges nothing beyond the allowance', async () => {
        const lines = await run(
            FreeDimensionOnInvoice.show,
            [
                dimension({
                    dimensionId: 'a',
                    dimensionName: 'A',
                    consumptionPrice: '1',
                    usageEntitlement: 5,
                    overageAllowed: 'false',
                }),
            ],
            { a: 7 },
        );
        expect(lines).toEqual([]);
    });

    test('allowance with overage neither true charges nothing', async () => {
        const lines = await run(
            FreeDimensionOnInvoice.show,
            [dimension({ dimensionId: 'a', dimensionName: 'A', consumptionPrice: '0.1', usageEntitlement: 50 })],
            { a: 70 },
        );
        expect(lines).toEqual([]);
    });

    test('zero priced dimension shows when free dimensions are shown', async () => {
        const lines = await run(
            FreeDimensionOnInvoice.show,
            [dimension({ dimensionId: 'a', dimensionName: 'A', consumptionPrice: '0.00' })],
            { a: 10 },
        );
        expect(lines).toEqual([{ name: 'A - Plan', quantity: 10, unitCost: 0 }]);
    });

    test('zero priced dimension is hidden when free dimensions are hidden', async () => {
        const lines = await run(
            FreeDimensionOnInvoice.hide,
            [dimension({ dimensionId: 'a', dimensionName: 'A', consumptionPrice: '0.00' })],
            { a: 10 },
        );
        expect(lines).toEqual([]);
    });
});

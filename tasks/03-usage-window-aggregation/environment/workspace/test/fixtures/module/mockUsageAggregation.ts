import { UsageAggregationEvent } from '../../../src/usage/usageAggregation.event';

/**
 * Stands in for the aggregated usage a customer's dimensions add up to, so a
 * spec can exercise everything downstream of it without reaching for the metric
 * store.
 */
export class MockUsageAggregation {
    getAggregateUsageForDimension = jest.fn(async () => []);

    constructor() {
        UsageAggregationEvent.getAggregateUsageForDimension = this.getAggregateUsageForDimension as never;
    }
}

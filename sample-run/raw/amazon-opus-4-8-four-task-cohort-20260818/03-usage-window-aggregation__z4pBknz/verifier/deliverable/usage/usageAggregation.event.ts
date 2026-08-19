import { ApiHideProperty, OmitType } from '@nestjs/swagger';
import { IsISO8601, IsNotEmpty, IsOptional, IsString } from 'class-validator';

import { AggregationPurpose } from '../customer/dto/AggregationPurpose.js';
import {
    AggregatedUsageResponse,
    BasicUsageDocument,
    MetadataGroupedAggregatedUsageResponse,
    UnAggregatedUsageResponse,
    UsageResponseDocument,
} from '../customer/dto/read-customer.dto.js';
import {
    aggregationInterval,
    aggregationMethod,
    ReadDimensionResponseData,
    SampleType,
} from '../dimensions/dto/create-dimension.dto.js';
import { SupportedResources } from '../measurement-config/entities/measurement-config.entity.js';
import { ReadOfferingResponseData } from '../offering/dto/readOffering.dto.js';
import {
    listUsageSeries,
    metadataOf,
    readUsageSamples,
    usageSeriesOf,
    UsageSample,
    UsageSeries,
} from '../utils/aws/cloudwatchUsage.js';
import { CreateUsageDto } from './dto/create-usage.dto.js';
import { UsageDocument } from './dto/read-usage.dto.js';

const { usageData } = SupportedResources;

/** What a dimension's aggregation method makes of a set of readings. */
const reduceSamples = (values: number[], method: aggregationMethod): number => {
    if (values.length === 0) {
        return 0;
    }
    switch (method) {
        case aggregationMethod.max:
            return Math.max(...values);
        case aggregationMethod.min:
            return Math.min(...values);
        case aggregationMethod.average:
            return values.reduce((total, value) => total + value, 0) / values.length;
        case aggregationMethod.count:
            return values.length;
        case aggregationMethod.last:
            return values[values.length - 1];
        default:
            return values.reduce((total, value) => total + value, 0);
    }
};

/** The step boundary at or before an instant, aligned to the calendar. */
const floorToInterval = (date: Date, interval: aggregationInterval): Date => {
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth();
    const d = date.getUTCDate();
    const h = date.getUTCHours();
    switch (interval) {
        case aggregationInterval.hour:
            return new Date(Date.UTC(y, m, d, h));
        case aggregationInterval.day:
            return new Date(Date.UTC(y, m, d));
        case aggregationInterval.month:
            return new Date(Date.UTC(y, m, 1));
        default:
            return new Date(date);
    }
};

/** The next step boundary after a boundary, aligned to the calendar. */
const nextBoundary = (date: Date, interval: aggregationInterval): Date => {
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth();
    const d = date.getUTCDate();
    const h = date.getUTCHours();
    switch (interval) {
        case aggregationInterval.hour:
            return new Date(Date.UTC(y, m, d, h + 1));
        case aggregationInterval.day:
            return new Date(Date.UTC(y, m, d + 1));
        case aggregationInterval.month:
            return new Date(Date.UTC(y, m + 1, 1));
        default:
            return new Date(date.getTime() + 1);
    }
};

/**
 * The steps the window is cut into, oldest first, each aligned to the requested
 * interval and covering the window end to end. Every step is returned, so a
 * window with no readings still hands back its full run of steps.
 */
const stepsOfWindow = (
    startTime: string,
    endTime: string,
    interval: aggregationInterval,
): Array<{ start: Date; end: Date }> => {
    const windowEnd = new Date(endTime);
    const steps: Array<{ start: Date; end: Date }> = [];
    let cursor = floorToInterval(new Date(startTime), interval);
    while (cursor < windowEnd) {
        const end = nextBoundary(cursor, interval);
        steps.push({ start: cursor, end });
        cursor = end;
    }
    return steps;
};

/** The standing level a provisioned series holds entering the window: the value
 * of the newest reading published at or before the window opens, if any. */
const standingLevelBefore = async (series: UsageSeries[], startTime: string): Promise<number | undefined> => {
    let latest: UsageSample | undefined;
    for (const single of series) {
        const priorSamples = await readUsageSamples({
            series: single,
            startTime: new Date(0),
            endTime: new Date(startTime),
        });
        for (const sample of priorSamples) {
            if (!latest || new Date(sample.timestamp) > new Date(latest.timestamp)) {
                latest = sample;
            }
        }
    }
    return latest ? latest.value : undefined;
};

/**
 * The curve one group of series adds up to over the window: one value per step,
 * oldest first. Readings are bucketed into the step that holds them and reduced
 * by the dimension's aggregation method. A provisioned dimension carries its
 * standing level through steps with no new reading; every other dimension shows
 * an unused step as zero rather than a hole.
 */
const curveOfGroup = async ({
    series,
    startTime,
    endTime,
    interval,
    method,
    provisioned,
}: {
    series: UsageSeries[];
    startTime: string;
    endTime: string;
    interval: aggregationInterval;
    method: aggregationMethod;
    provisioned: boolean;
}): Promise<UsageResponseDocument[]> => {
    const samples: UsageSample[] = [];
    for (const single of series) {
        const read = await readUsageSamples({
            series: single,
            startTime: new Date(startTime),
            endTime: new Date(endTime),
        });
        read.forEach((sample) => samples.push(sample));
    }
    // Readings come back in no useful order; sort oldest first so bucketing and
    // the "last" reduction behave predictably.
    samples.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    let carry = provisioned ? await standingLevelBefore(series, startTime) : undefined;

    return stepsOfWindow(startTime, endTime, interval).map(({ start, end }) => {
        const inStep = samples
            .filter((sample) => {
                const at = new Date(sample.timestamp);
                return at >= start && at < end;
            })
            .map((sample) => sample.value);
        let value: number;
        if (inStep.length > 0) {
            value = reduceSamples(inStep, method);
            carry = value;
        } else if (provisioned && carry !== undefined) {
            value = carry;
        } else {
            value = 0;
        }
        return new UsageDocument({
            value: value.toString(),
            startTime: start.toISOString(),
            endTime: end.toISOString(),
        });
    });
};

export class UsageAggregationEvent {
    public customerId: string;
    public offeringDocument: ReadOfferingResponseData;

    /**
     * The unique identifier for the SaaS business
     * @example HarperDB
     */
    @ApiHideProperty()
    @IsString()
    @IsNotEmpty()
    public businessID: string;

    @IsString()
    @IsNotEmpty()
    @IsISO8601()
    public startTime: string;

    @IsString()
    @IsNotEmpty()
    @IsISO8601()
    @IsOptional()
    public endTime: string;

    public clientID: string;

    public applicationId?: string;

    public aggregationPurpose?: AggregationPurpose;

    private static dimensionFunctionMap = {
        [usageData]: async ({
            businessID,
            startTime,
            endTime,
            dimension,
            customerId,
            offeringId,
        }: SingleUsageEvent): Promise<
            Array<UnAggregatedUsageResponse | AggregatedUsageResponse | MetadataGroupedAggregatedUsageResponse>
        > => {
            const {
                dimensionId,
                aggregationInterval: argumentAgg,
                aggregationMethod: argumentAggregationMethod,
                sampleType,
            } = dimension as ReadDimensionResponseData;
            const published = await listUsageSeries({ businessID, customerId, dimensionId });

            if (argumentAgg !== aggregationInterval.none) {
                // A provisioned dimension holds a standing level between readings, so a
                // step with no new reading keeps the level it was last handed rather
                // than dropping to zero.
                const provisioned = sampleType === SampleType.continious;

                // Metadata-priced dimensions are tiered apart by finance, so each
                // metadata group is reported as a series of its own alongside the
                // plain one.
                const groups = new Map<string, { metadata: Record<string, string>; series: UsageSeries[] }>();
                for (const series of published) {
                    const metadata = metadataOf(series);
                    const key = JSON.stringify(metadata);
                    if (!groups.has(key)) {
                        groups.set(key, { metadata, series: [] });
                    }
                    groups.get(key).series.push(series);
                }
                // Even a customer with no readings gets the dimension back, so an
                // account with no series at all still yields a plain zero curve.
                if (groups.size === 0) {
                    groups.set('{}', { metadata: {}, series: [] });
                }

                const responses: Array<AggregatedUsageResponse | MetadataGroupedAggregatedUsageResponse> = [];
                for (const { metadata, series } of groups.values()) {
                    const hasMetadata = Object.keys(metadata).length > 0;
                    const usage = await curveOfGroup({
                        series,
                        startTime,
                        endTime,
                        interval: argumentAgg,
                        method: argumentAggregationMethod,
                        provisioned,
                    });
                    if (hasMetadata) {
                        responses.push({ offeringId, dimensionId, metadataGroup: metadata, usage });
                    } else {
                        responses.push({ offeringId, dimensionId, usage });
                    }
                }
                return responses;
            }

            const unAggregatedResults: BasicUsageDocument[] = [];
            for (const series of published) {
                const samples = await readUsageSamples({
                    series,
                    startTime: new Date(startTime),
                    endTime: new Date(endTime),
                });
                const metadata = metadataOf(series);
                samples.forEach(({ timestamp, value }) => {
                    unAggregatedResults.push({ timestamp, recordValue: value.toString(), metadata });
                });
            }
            return [{ offeringId, dimensionId, usage: unAggregatedResults }] as UnAggregatedUsageResponse[];
        },
    };

    static buildAggregationQueries = async ({
        offeringDocument,
        ...rest
    }: UsageAggregationEvent): Promise<
        Array<UnAggregatedUsageResponse | AggregatedUsageResponse | MetadataGroupedAggregatedUsageResponse>
    > => {
        const results = await Promise.all(
            offeringDocument.dimensions.map(async ({ dimensionId, ...dimensionRest }) =>
                UsageAggregationEvent.dimensionFunctionMap['usageData']({
                    dimension: { ...dimensionRest, dimensionId },
                    offeringId: offeringDocument?.offeringId,
                    ...rest,
                }),
            ),
        );
        return results.flat();
    };

    static getAggregateUsageForDimension = async (
        aggregateEvent: UsageAggregationEvent,
    ): Promise<AggregatedUsageResponse[] | UnAggregatedUsageResponse[] | MetadataGroupedAggregatedUsageResponse[]> => {
        const res = await UsageAggregationEvent.buildAggregationQueries(aggregateEvent);
        if (res && res.length > 0) {
            return res.reduce((acc, queryRes) => {
                if (Array.isArray(queryRes)) {
                    queryRes.forEach((row) => {
                        //eslint-disable-next-line
                        // @ts-ignore
                        acc.push(row);
                    });
                    return acc;
                } else {
                    //eslint-disable-next-line
                    // @ts-ignore
                    acc.push(queryRes);
                    return acc;
                }
            }, []) as
                | AggregatedUsageResponse[]
                | UnAggregatedUsageResponse[]
                | MetadataGroupedAggregatedUsageResponse[];
        } else {
            return [];
        }
    };

    public static convertCreateUsageDtoToAggregateUsageResponse(
        CreateUsageDto: CreateUsageDto[],
    ): AggregatedUsageResponse[] {
        return CreateUsageDto.map(({ dimensionId, recordValue, ...rest }) => {
            return { dimensionId, usage: [new UsageDocument({ ...rest, value: recordValue })] };
        });
    }
}

class SingleUsageEvent extends OmitType(UsageAggregationEvent, ['offeringDocument'] as const) {
    public dimension: ReadDimensionResponseData;
    public offeringId?: string;
}

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
    aggregationIntervalInMS,
    aggregationMethod,
    ReadDimensionResponseData,
    SampleType,
} from '../dimensions/dto/create-dimension.dto.js';
import { SupportedResources } from '../measurement-config/entities/measurement-config.entity.js';
import { ReadOfferingResponseData } from '../offering/dto/readOffering.dto.js';
import { listUsageSeries, metadataOf, readUsageSamples, usageSeriesOf } from '../utils/aws/cloudwatchUsage.js';
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

/** Whether a dimension holds a standing level that persists between readings. */
const isProvisioned = (dimension: ReadDimensionResponseData): boolean =>
    (dimension as ReadDimensionResponseData).sampleType === SampleType.continious;

/** The instant one aggregation step past the given one, aligned to natural boundaries. */
const nextBoundary = (date: Date, interval: aggregationInterval): Date => {
    const next = new Date(date.getTime());
    switch (interval) {
        case aggregationInterval.month:
            next.setUTCMilliseconds(0);
            next.setUTCSeconds(0);
            next.setUTCMinutes(0);
            next.setUTCHours(0);
            next.setUTCDate(1);
            next.setUTCMonth(next.getUTCMonth() + 1);
            return next;
        case aggregationInterval.day:
            next.setUTCMilliseconds(0);
            next.setUTCSeconds(0);
            next.setUTCMinutes(0);
            next.setUTCHours(0);
            next.setUTCDate(next.getUTCDate() + 1);
            return next;
        case aggregationInterval.hour:
        default:
            next.setUTCMilliseconds(0);
            next.setUTCSeconds(0);
            next.setUTCMinutes(0);
            next.setUTCHours(next.getUTCHours() + 1);
            return next;
    }
};

/**
 * The aggregation steps that tile the requested window end to end, oldest
 * first, aligned to the interval's natural boundaries and clipped to the
 * window so no reading falls outside a step and no step spills past the edges.
 */
const buildSteps = (
    startTime: string,
    endTime: string,
    interval: aggregationInterval,
): Array<{ startTime: string; endTime: string }> => {
    const windowStart = new Date(startTime);
    const windowEnd = new Date(endTime);
    const steps: Array<{ startTime: string; endTime: string }> = [];
    let cursor = windowStart;
    while (cursor.getTime() < windowEnd.getTime()) {
        const boundary = nextBoundary(cursor, interval);
        const stepEnd = boundary.getTime() < windowEnd.getTime() ? boundary : windowEnd;
        steps.push({ startTime: cursor.toISOString(), endTime: stepEnd.toISOString() });
        cursor = stepEnd;
    }
    return steps;
};

/** How far back to look for a provisioned dimension's standing level before the window. */
const PROVISIONED_LOOKBACK_MS = aggregationIntervalInMS.month * 12;

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

    /**
     * One dimension's readings from CloudWatch, shaped into the curve the
     * portal asks for. Series are split by their metadata so a metadata-priced
     * dimension comes back as one group per distinct metadata set, and the
     * plain (metadata-free) series stays its own group.
     */
    private static dimensionFunctionMap = {
        [usageData]: async ({
            businessID,
            startTime,
            endTime,
            dimension,
            customerId,
        }: SingleUsageEvent): Promise<
            Array<{ metadataGroup?: Record<string, string>; usage: BasicUsageDocument[] | UsageResponseDocument[] }>
        > => {
            const {
                dimensionId,
                aggregationInterval: argumentAgg,
                aggregationMethod: argumentAggregationMethod,
            } = dimension as ReadDimensionResponseData;
            const provisioned = isProvisioned(dimension as ReadDimensionResponseData);
            const published = await listUsageSeries({ businessID, customerId, dimensionId });

            // Split the published series into groups keyed by their metadata so
            // finance can tier each metadata group apart.
            const groups = new Map<string, { metadata: Record<string, string>; series: typeof published }>();
            for (const series of published) {
                const metadata = metadataOf(series);
                const key = JSON.stringify(metadata);
                if (!groups.has(key)) {
                    groups.set(key, { metadata, series: [] });
                }
                groups.get(key).series.push(series);
            }
            // Always return the dimension, even when the customer has no
            // readings at all, so the curve still covers the window.
            if (groups.size === 0) {
                groups.set(JSON.stringify({}), { metadata: {}, series: [] });
            }

            const buildGroup = async (metadata: Record<string, string>, series: typeof published) => {
                const hasMetadata = Object.keys(metadata).length > 0;
                const metadataGroup = hasMetadata ? metadata : undefined;

                if (argumentAgg === aggregationInterval.none) {
                    const unAggregatedResults: BasicUsageDocument[] = [];
                    for (const singleSeries of series) {
                        const samples = await readUsageSamples({
                            series: singleSeries,
                            startTime: new Date(startTime),
                            endTime: new Date(endTime),
                        });
                        samples.forEach(({ timestamp, value }) => {
                            unAggregatedResults.push({ timestamp, recordValue: value.toString(), metadata });
                        });
                    }
                    return { metadataGroup, usage: unAggregatedResults as BasicUsageDocument[] };
                }

                // Gather every reading in the window across the group's series.
                const windowSamples: Array<{ timestamp: number; value: number }> = [];
                for (const singleSeries of series) {
                    const samples = await readUsageSamples({
                        series: singleSeries,
                        startTime: new Date(startTime),
                        endTime: new Date(endTime),
                    });
                    samples.forEach(({ timestamp, value }) =>
                        windowSamples.push({ timestamp: new Date(timestamp).getTime(), value }),
                    );
                }
                windowSamples.sort((a, b) => a.timestamp - b.timestamp);

                // A provisioned dimension carries a standing level, so seed it
                // with the newest reading from before the window began.
                let standingLevel = 0;
                if (provisioned) {
                    const lookbackStart = new Date(new Date(startTime).getTime() - PROVISIONED_LOOKBACK_MS);
                    let latest: { timestamp: number; value: number } | undefined;
                    for (const singleSeries of series) {
                        const priorSamples = await readUsageSamples({
                            series: singleSeries,
                            startTime: lookbackStart,
                            endTime: new Date(startTime),
                        });
                        priorSamples.forEach(({ timestamp, value }) => {
                            const ts = new Date(timestamp).getTime();
                            if (!latest || ts > latest.timestamp) {
                                latest = { timestamp: ts, value };
                            }
                        });
                    }
                    if (latest) {
                        standingLevel = latest.value;
                    }
                }

                const steps = buildSteps(startTime, endTime, argumentAgg);
                const usage = steps.map((step) => {
                    const stepStart = new Date(step.startTime).getTime();
                    const stepEnd = new Date(step.endTime).getTime();
                    const readings = windowSamples
                        .filter(({ timestamp }) => timestamp >= stepStart && timestamp < stepEnd)
                        .map(({ value }) => value);
                    let value: number;
                    if (readings.length > 0) {
                        value = reduceSamples(readings, argumentAggregationMethod);
                        if (provisioned) {
                            standingLevel = value;
                        }
                    } else if (provisioned) {
                        // Carry the standing level through steps with no reading.
                        value = standingLevel;
                    } else {
                        // Represent unused steps as zero rather than holes.
                        value = 0;
                    }
                    return new UsageDocument({
                        value: value.toString(),
                        startTime: step.startTime,
                        endTime: step.endTime,
                        metadataGroup,
                    });
                });
                return { metadataGroup, usage: usage as UsageResponseDocument[] };
            };

            const results = await Promise.all(
                Array.from(groups.values()).map(({ metadata, series }) => buildGroup(metadata, series)),
            );
            return results;
        },
    };

    static buildAggregationQueries = async ({
        offeringDocument,
        ...rest
    }: UsageAggregationEvent): Promise<
        Array<UnAggregatedUsageResponse | AggregatedUsageResponse | MetadataGroupedAggregatedUsageResponse>
    > => {
        const perDimension = await Promise.all(
            offeringDocument.dimensions.map(async ({ dimensionId, ...dimensionRest }) => {
                const groups = await UsageAggregationEvent.dimensionFunctionMap['usageData']({
                    dimension: { ...dimensionRest, dimensionId },
                    ...rest,
                });
                return groups.map(({ metadataGroup, usage }) => ({
                    offeringId: offeringDocument?.offeringId,
                    dimensionId,
                    ...(metadataGroup ? { metadataGroup } : {}),
                    usage,
                }));
            }),
        );
        return perDimension.flat() as Array<
            UnAggregatedUsageResponse | AggregatedUsageResponse | MetadataGroupedAggregatedUsageResponse
        >;
    };

    static getAggregateUsageForDimension = async (
        aggregateEvent: UsageAggregationEvent,
    ): Promise<
        AggregatedUsageResponse[] | UnAggregatedUsageResponse[] | MetadataGroupedAggregatedUsageResponse[]
    > => {
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
}

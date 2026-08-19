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

/** One aggregation step: the half-open window [start, end). */
type AggregationStep = { start: Date; end: Date };

/**
 * Advance one instant by the aggregation interval it steps in, keeping to the
 * calendar for months so a step lands on the same day of the next month.
 */
const advanceStep = (from: Date, interval: aggregationInterval): Date => {
    const next = new Date(from.getTime());
    switch (interval) {
        case aggregationInterval.hour:
            next.setUTCHours(next.getUTCHours() + 1);
            return next;
        case aggregationInterval.day:
            next.setUTCDate(next.getUTCDate() + 1);
            return next;
        case aggregationInterval.month:
            next.setUTCMonth(next.getUTCMonth() + 1);
            return next;
        default:
            return new Date(from.getTime());
    }
};

/**
 * The aggregation steps that cover a window end to end, oldest first. Every
 * step is the interval wide but the last one is clamped to the window's end so
 * the curve never runs past what was asked for.
 */
const stepsForWindow = (startTime: Date, endTime: Date, interval: aggregationInterval): AggregationStep[] => {
    const steps: AggregationStep[] = [];
    if (!(endTime.getTime() > startTime.getTime())) {
        return steps;
    }
    let cursor = new Date(startTime.getTime());
    let guard = 0;
    while (cursor.getTime() < endTime.getTime() && guard < 100000) {
        let next = advanceStep(cursor, interval);
        if (next.getTime() <= cursor.getTime()) {
            next = new Date(endTime.getTime());
        }
        if (next.getTime() > endTime.getTime()) {
            next = new Date(endTime.getTime());
        }
        steps.push({ start: new Date(cursor.getTime()), end: new Date(next.getTime()) });
        cursor = next;
        guard += 1;
    }
    return steps;
};

/**
 * A provisioned dimension holds a standing level between readings, so a step
 * that saw no reading keeps the last one instead of dropping to zero.
 */
const isProvisioned = (dimension: ReadDimensionResponseData): boolean =>
    dimension?.sampleType === SampleType.continious;

/**
 * Lay a series' readings onto the requested steps, reducing the readings that
 * fall in a step with the dimension's method. A step with no reading is zero,
 * unless the dimension is provisioned, in which case its standing level is
 * carried forward from the last step that had one.
 */
const curveFromSamples = (
    samples: UsageSampleReading[],
    steps: AggregationStep[],
    method: aggregationMethod,
    provisioned: boolean,
): number[] => {
    const buckets: number[][] = steps.map(() => []);
    samples.forEach(({ timestamp, value }) => {
        const at = new Date(timestamp).getTime();
        for (let i = 0; i < steps.length; i += 1) {
            if (at >= steps[i].start.getTime() && at < steps[i].end.getTime()) {
                buckets[i].push(value);
                break;
            }
        }
    });
    let carried = 0;
    return steps.map((_step, i) => {
        if (buckets[i].length > 0) {
            carried = reduceSamples(buckets[i], method);
            return carried;
        }
        return provisioned ? carried : 0;
    });
};

type UsageSampleReading = { timestamp: string; value: number };

/** One metadata group's curve for a dimension, before it is shaped into a response row. */
type DimensionUsageCurve = { metadataGroup?: Record<string, string>; usage: UsageResponseDocument[] };

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
        }: SingleUsageEvent): Promise<BasicUsageDocument[] | DimensionUsageCurve[]> => {
            const {
                dimensionId,
                aggregationInterval: argumentAgg,
                aggregationMethod: argumentAggregationMethod,
            } = dimension as ReadDimensionResponseData;
            const published = await listUsageSeries({ businessID, customerId, dimensionId });

            if (argumentAgg !== aggregationInterval.none) {
                const steps = stepsForWindow(new Date(startTime), new Date(endTime), argumentAgg);
                const provisioned = isProvisioned(dimension as ReadDimensionResponseData);

                // Each distinct metadata group is priced apart, so gather the
                // readings of every series into the group it was published under
                // and hand each group back its own curve. The plain series (one
                // with no metadata) is the base group and carries no metadataGroup.
                const groups = new Map<string, { metadata: Record<string, string>; samples: UsageSampleReading[] }>();
                for (const series of published) {
                    const metadata = metadataOf(series);
                    const key = JSON.stringify(metadata);
                    if (!groups.has(key)) {
                        groups.set(key, { metadata, samples: [] });
                    }
                    const samples = await readUsageSamples({
                        series,
                        startTime: new Date(startTime),
                        endTime: new Date(endTime),
                    });
                    samples.forEach(({ timestamp, value }) => groups.get(key).samples.push({ timestamp, value }));
                }

                // Return every requested step even when the customer has no
                // readings at all, so the base group is always present.
                if (groups.size === 0) {
                    groups.set(JSON.stringify({}), { metadata: {}, samples: [] });
                }

                const curves: DimensionUsageCurve[] = [];
                for (const { metadata, samples } of groups.values()) {
                    const values = curveFromSamples(samples, steps, argumentAggregationMethod, provisioned);
                    const usage = steps.map(
                        (step, i) =>
                            new UsageDocument({
                                value: values[i].toString(),
                                startTime: step.start.toISOString(),
                                endTime: step.end.toISOString(),
                            } as UsageDocument),
                    );
                    curves.push({
                        metadataGroup: Object.keys(metadata).length > 0 ? metadata : undefined,
                        usage: usage as UsageResponseDocument[],
                    });
                }
                return curves;
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
            return unAggregatedResults as BasicUsageDocument[];
        },
    };

    static buildAggregationQueries = async ({
        offeringDocument,
        ...rest
    }: UsageAggregationEvent): Promise<
        Array<UnAggregatedUsageResponse | AggregatedUsageResponse | MetadataGroupedAggregatedUsageResponse[]>
    > => {
        const results = await Promise.all(
            offeringDocument.dimensions.map(async ({ dimensionId, ...dimensionRest }) => {
                const dimension = { ...dimensionRest, dimensionId } as ReadDimensionResponseData;
                const usage = await UsageAggregationEvent.dimensionFunctionMap['usageData']({
                    dimension,
                    ...rest,
                });

                if (dimension.aggregationInterval !== aggregationInterval.none) {
                    // Aggregated dimensions come back as one curve per metadata
                    // group; each group is its own response row.
                    return (usage as DimensionUsageCurve[]).map((curve) => ({
                        offeringId: offeringDocument?.offeringId,
                        dimensionId,
                        usage: curve.usage,
                        ...(curve.metadataGroup ? { metadataGroup: curve.metadataGroup } : {}),
                    })) as MetadataGroupedAggregatedUsageResponse[];
                }

                return {
                    offeringId: offeringDocument?.offeringId,
                    dimensionId,
                    usage,
                } as UnAggregatedUsageResponse;
            }),
        );
        return results as Array<
            UnAggregatedUsageResponse | AggregatedUsageResponse | MetadataGroupedAggregatedUsageResponse[]
        >;
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
}

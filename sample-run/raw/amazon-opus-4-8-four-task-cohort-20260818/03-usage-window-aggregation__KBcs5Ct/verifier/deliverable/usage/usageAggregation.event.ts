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

/** One reading of one published series. */
type SampledReading = { timestamp: string; value: number };

/** A dimension result for a single (optionally metadata keyed) series group. */
type UsageResponseFragment = {
    metadataGroup?: Record<string, string>;
    usage: UsageResponseDocument[] | BasicUsageDocument[];
};

/**
 * Turn a bag of readings into the curve the portal asks for: one entry per
 * aggregation step, covering the window end to end in oldest-first order. A
 * step with no reading is zero rather than a hole, unless the dimension is a
 * provisioned one (aggregated by its last standing value), in which case the
 * last known standing level is carried forward through the empty steps.
 */
const buildStepCurve = ({
    samples,
    startTime,
    endTime,
    intervalMs,
    method,
    carryForward,
    metadataGroup,
}: {
    samples: SampledReading[];
    startTime: string;
    endTime: string;
    intervalMs: number;
    method: aggregationMethod;
    carryForward: boolean;
    metadataGroup?: Record<string, string>;
}): UsageResponseDocument[] => {
    const windowStart = new Date(startTime).getTime();
    const windowEnd = new Date(endTime).getTime();
    const ordered = [...samples].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    // A window that cannot be split into steps still returns a single step so
    // the dimension is always represented.
    if (!(intervalMs > 0) || !(windowEnd > windowStart)) {
        return [
            new UsageDocument({
                value: reduceSamples(
                    ordered.map(({ value }) => value),
                    method,
                ).toString(),
                startTime,
                endTime,
                metadataGroup,
            }),
        ];
    }

    const steps = Math.ceil((windowEnd - windowStart) / intervalMs);
    const curve: UsageResponseDocument[] = [];
    let standingLevel: number | null = null;
    for (let step = 0; step < steps; step += 1) {
        const stepStart = windowStart + step * intervalMs;
        const stepEnd = stepStart + intervalMs;
        const readings = ordered
            .filter(({ timestamp }) => {
                const at = new Date(timestamp).getTime();
                return at >= stepStart && at < stepEnd;
            })
            .map(({ value }) => value);
        let value: number;
        if (readings.length > 0) {
            value = reduceSamples(readings, method);
            standingLevel = value;
        } else {
            value = carryForward && standingLevel !== null ? standingLevel : 0;
        }
        curve.push(
            new UsageDocument({
                value: value.toString(),
                startTime: new Date(stepStart).toISOString(),
                endTime: new Date(Math.min(stepEnd, windowEnd)).toISOString(),
                metadataGroup,
            }),
        );
    }
    return curve;
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
        }: SingleUsageEvent): Promise<UsageResponseFragment[]> => {
            const {
                dimensionId,
                aggregationInterval: argumentAgg,
                aggregationMethod: argumentAggregationMethod,
            } = dimension as ReadDimensionResponseData;
            const published = await listUsageSeries({ businessID, customerId, dimensionId });

            // Raw, un-aggregated readings keep their per-reading shape and carry
            // whatever metadata they were published with.
            if (argumentAgg === aggregationInterval.none) {
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
                return [{ usage: unAggregatedResults }];
            }

            // Gather each published series' readings under its metadata group so
            // metadata-priced dimensions can be reported apart from one another.
            const groups = new Map<string, { metadata: Record<string, string>; samples: SampledReading[] }>();
            for (const series of published) {
                const samples = await readUsageSamples({
                    series,
                    startTime: new Date(startTime),
                    endTime: new Date(endTime),
                });
                const metadata = metadataOf(series);
                const key = JSON.stringify(metadata);
                if (!groups.has(key)) {
                    groups.set(key, { metadata, samples: [] });
                }
                groups.get(key).samples.push(...samples);
            }

            // Even with nothing published the dimension is returned so the curve
            // still covers the window, filled with zeroes.
            if (groups.size === 0) {
                groups.set('{}', { metadata: {}, samples: [] });
            }

            const carryForward = argumentAggregationMethod === aggregationMethod.last;
            const intervalMs = aggregationIntervalInMS[argumentAgg];

            return [...groups.values()].map(({ metadata, samples }) => {
                const hasMetadata = Object.keys(metadata).length > 0;
                const metadataGroup = hasMetadata ? metadata : undefined;
                const usage = buildStepCurve({
                    samples,
                    startTime,
                    endTime,
                    intervalMs,
                    method: argumentAggregationMethod,
                    carryForward,
                    metadataGroup,
                });
                const fragment: UsageResponseFragment = { usage };
                if (hasMetadata) {
                    fragment.metadataGroup = metadata;
                }
                return fragment;
            });
        },
    };

    static buildAggregationQueries = async ({
        offeringDocument,
        ...rest
    }: UsageAggregationEvent): Promise<
        Array<UnAggregatedUsageResponse | AggregatedUsageResponse | MetadataGroupedAggregatedUsageResponse>[]
    > => {
        const results = await Promise.all(
            offeringDocument.dimensions.map(async ({ dimensionId, ...dimensionRest }) => {
                const fragments = await UsageAggregationEvent.dimensionFunctionMap['usageData']({
                    dimension: { ...dimensionRest, dimensionId },
                    ...rest,
                });
                return fragments.map((fragment) => ({
                    offeringId: offeringDocument?.offeringId,
                    dimensionId,
                    ...fragment,
                }));
            }),
        );
        return results as Array<
            UnAggregatedUsageResponse | AggregatedUsageResponse | MetadataGroupedAggregatedUsageResponse
        >[];
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

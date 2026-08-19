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

/**
 * A dimension's readings turned into a curve of aggregation steps that covers
 * the requested window end to end, oldest step first. Every step is present so
 * the caller never has to reason about holes: a step with no reading is zero
 * for an ordinary dimension, or the standing level carried forward for a
 * provisioned one. Readings arriving from CloudWatch are newest first, so we
 * sort each step's readings oldest first before the aggregation method folds
 * them.
 */
const buildUsageCurve = ({
    samples,
    startTime,
    endTime,
    interval,
    method,
    provisioned,
}: {
    samples: { timestamp: string; value: number }[];
    startTime: string;
    endTime: string;
    interval: aggregationInterval;
    method: aggregationMethod;
    provisioned: boolean;
}): UsageResponseDocument[] => {
    const windowStart = new Date(startTime).getTime();
    const windowEnd = new Date(endTime).getTime();
    const stepMs = aggregationIntervalInMS[interval];
    const steps = Math.max(0, Math.ceil((windowEnd - windowStart) / stepMs));

    const curve: UsageResponseDocument[] = [];
    let standingLevel = 0;
    for (let index = 0; index < steps; index += 1) {
        const stepStart = windowStart + index * stepMs;
        const stepEnd = Math.min(stepStart + stepMs, windowEnd);
        const readings = samples
            .filter(({ timestamp }) => {
                const at = new Date(timestamp).getTime();
                return at >= stepStart && at < stepEnd;
            })
            .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
            .map(({ value }) => value);

        let value: number;
        if (readings.length > 0) {
            value = reduceSamples(readings, method);
            if (provisioned) {
                standingLevel = value;
            }
        } else {
            value = provisioned ? standingLevel : 0;
        }

        curve.push(
            new UsageDocument({
                value: value.toString(),
                startTime: new Date(stepStart).toISOString(),
                endTime: new Date(stepEnd).toISOString(),
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
            offeringId,
        }: SingleUsageEvent): Promise<
            Array<AggregatedUsageResponse | MetadataGroupedAggregatedUsageResponse | UnAggregatedUsageResponse>
        > => {
            const {
                dimensionId,
                aggregationInterval: argumentAgg,
                aggregationMethod: argumentAggregationMethod,
                sampleType,
            } = dimension as ReadDimensionResponseData;
            const published = await listUsageSeries({ businessID, customerId, dimensionId });

            // Raw, un-aggregated readings keep their metadata on each record.
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
                return [{ offeringId, dimensionId, usage: unAggregatedResults } as UnAggregatedUsageResponse];
            }

            // Aggregated: one curve per published series. A series carrying
            // metadata is priced apart, so it becomes its own grouped response;
            // the plain series stays the dimension's base response.
            const provisioned = sampleType === SampleType.gauge;
            const responses: Array<AggregatedUsageResponse | MetadataGroupedAggregatedUsageResponse> = [];
            let hasPlainSeries = false;
            for (const series of published) {
                const samples = await readUsageSamples({
                    series,
                    startTime: new Date(startTime),
                    endTime: new Date(endTime),
                });
                const metadata = metadataOf(series);
                const usage = buildUsageCurve({
                    samples,
                    startTime,
                    endTime,
                    interval: argumentAgg,
                    method: argumentAggregationMethod,
                    provisioned,
                });
                if (Object.keys(metadata).length > 0) {
                    responses.push({ offeringId, dimensionId, metadataGroup: metadata, usage });
                } else {
                    hasPlainSeries = true;
                    responses.push({ offeringId, dimensionId, usage });
                }
            }

            // Even with no readings at all we still hand back the base curve of
            // zero steps so the window is covered end to end.
            if (!hasPlainSeries) {
                responses.push({
                    offeringId,
                    dimensionId,
                    usage: buildUsageCurve({
                        samples: [],
                        startTime,
                        endTime,
                        interval: argumentAgg,
                        method: argumentAggregationMethod,
                        provisioned,
                    }),
                });
            }

            return responses;
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
        return results.flat() as Array<
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
    public offeringId?: string;
}

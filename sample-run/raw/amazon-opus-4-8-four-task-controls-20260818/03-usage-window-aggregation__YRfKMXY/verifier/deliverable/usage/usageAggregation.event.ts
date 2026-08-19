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
        }: SingleUsageEvent): Promise<BasicUsageDocument[] | UsageResponseDocument[]> => {
            const {
                dimensionId,
                aggregationInterval: argumentAgg,
                aggregationMethod: argumentAggregationMethod,
            } = dimension as ReadDimensionResponseData;
            const published = await listUsageSeries({ businessID, customerId, dimensionId });

            if (argumentAgg !== aggregationInterval.none) {
                const readings: number[] = [];
                for (const series of published) {
                    const samples = await readUsageSamples({
                        series,
                        startTime: new Date(startTime),
                        endTime: new Date(endTime),
                    });
                    samples.forEach(({ value }) => readings.push(value));
                }
                return [
                    new UsageDocument({
                        value: reduceSamples(readings, argumentAggregationMethod).toString(),
                        startTime,
                        endTime,
                    }),
                ] as UsageResponseDocument[];
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
                return {
                    offeringId: offeringDocument?.offeringId,
                    dimensionId,
                    usage: await UsageAggregationEvent.dimensionFunctionMap['usageData']({
                        dimension: { ...dimensionRest, dimensionId },
                        ...rest,
                    }),
                };
            }),
        );
        return results as Array<UnAggregatedUsageResponse | AggregatedUsageResponse>;
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

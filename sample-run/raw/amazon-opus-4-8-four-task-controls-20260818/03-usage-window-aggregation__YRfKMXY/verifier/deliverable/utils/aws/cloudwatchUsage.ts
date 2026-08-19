import { BadRequestException } from '@nestjs/common';
import { CloudWatchClient, GetMetricDataCommand, ListMetricsCommand } from '@aws-sdk/client-cloudwatch';

/**
 * Usage handed to us for a customer's dimensions is published to CloudWatch
 * under one namespace and one metric name, with a dimension set naming the
 * business, the customer and the dimension the reading belongs to. A reading
 * that arrives carrying metadata publishes an extra CloudWatch dimension for
 * each metadata key it has, so every distinct metadata group ends up a series
 * of its own alongside the plain one.
 */
export const USAGE_NAMESPACE = 'Metering/Usage';
export const USAGE_METRIC_NAME = 'DimensionUsage';
export const METADATA_DIMENSION_PREFIX = 'Metadata_';

/** The CloudWatch dimension set identifying one published series. */
export type UsageSeries = Record<string, string>;

/** One reading of one series, as it was published. */
export type UsageSample = { timestamp: string; value: number };

/**
 * A series carries at most one reading a minute, so asking for a one minute
 * period hands back the readings themselves rather than a summary of them.
 */
const SAMPLE_PERIOD_SECONDS = 60;

const usageClient = () => new CloudWatchClient({ region: process.env.AWS_REGION });

const failed = (err) => {
    if (err?.Code === 'AccessDenied' || err?.name === 'AccessDenied') {
        throw new BadRequestException('Invalid credentials for the usage metric store');
    }
    throw new BadRequestException(`Error fetching usage metrics: ${err?.message ?? err}`);
};

/** The dimension set every reading for a customer's dimension carries. */
export const usageSeriesOf = ({
    businessID,
    customerId,
    dimensionId,
}: {
    businessID: string;
    customerId: string;
    dimensionId: string;
}): UsageSeries => ({
    BusinessId: businessID,
    CustomerId: customerId,
    DimensionId: dimensionId,
});

/**
 * The metadata a series carries, keyed the way a dimension's metadata groups
 * are keyed. A series published without metadata has none.
 */
export const metadataOf = (series: UsageSeries): Record<string, string> =>
    Object.keys(series)
        .filter((name) => name.startsWith(METADATA_DIMENSION_PREFIX))
        .sort()
        .reduce((acc, name) => {
            acc[name.slice(METADATA_DIMENSION_PREFIX.length)] = series[name];
            return acc;
        }, {} as Record<string, string>);

/**
 * Every series published for one customer's dimension. ListMetrics matches on
 * the dimensions it is handed and lets a series carry more of them, so the
 * reply covers the plain series and each metadata group that has been seen.
 */
export const listUsageSeries = async ({
    businessID,
    customerId,
    dimensionId,
}: {
    businessID: string;
    customerId: string;
    dimensionId: string;
}): Promise<UsageSeries[]> => {
    const wanted = usageSeriesOf({ businessID, customerId, dimensionId });
    try {
        const cloudwatchClient = usageClient();
        const published: UsageSeries[] = [];
        let next: string;
        do {
            const response = await cloudwatchClient.send(
                new ListMetricsCommand({
                    Namespace: USAGE_NAMESPACE,
                    MetricName: USAGE_METRIC_NAME,
                    Dimensions: Object.keys(wanted).map((Name) => ({ Name, Value: wanted[Name] })),
                    NextToken: next,
                }),
            );
            (response?.Metrics ?? []).forEach(({ Dimensions }) => {
                published.push(
                    (Dimensions ?? []).reduce((acc, { Name, Value }) => {
                        acc[Name] = Value;
                        return acc;
                    }, {} as UsageSeries),
                );
            });
            next = response?.NextToken;
        } while (next);
        return published;
    } catch (err) {
        return failed(err);
    }
};

/**
 * The readings one series holds between two instants, as published. The reply
 * is inclusive of the start and exclusive of the end, arrives newest first,
 * and pages once it fills up.
 */
export const readUsageSamples = async ({
    series,
    startTime,
    endTime,
}: {
    series: UsageSeries;
    startTime: Date;
    endTime: Date;
}): Promise<UsageSample[]> => {
    try {
        const cloudwatchClient = usageClient();
        const samples: UsageSample[] = [];
        let next: string;
        do {
            const response = await cloudwatchClient.send(
                new GetMetricDataCommand({
                    StartTime: startTime,
                    EndTime: endTime,
                    NextToken: next,
                    MetricDataQueries: [
                        {
                            Id: 'usage',
                            MetricStat: {
                                Metric: {
                                    Namespace: USAGE_NAMESPACE,
                                    MetricName: USAGE_METRIC_NAME,
                                    Dimensions: Object.keys(series).map((Name) => ({
                                        Name,
                                        Value: series[Name],
                                    })),
                                },
                                Period: SAMPLE_PERIOD_SECONDS,
                                Stat: 'Maximum',
                            },
                            ReturnData: true,
                        },
                    ],
                }),
            );
            (response?.MetricDataResults ?? []).forEach(({ Timestamps, Values }) => {
                (Timestamps ?? []).forEach((timestamp, index) => {
                    samples.push({
                        timestamp: new Date(timestamp).toISOString(),
                        value: Number(Values?.[index]),
                    });
                });
            });
            next = response?.NextToken;
        } while (next);
        return samples;
    } catch (err) {
        return failed(err);
    }
};

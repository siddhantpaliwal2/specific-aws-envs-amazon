/*
 * Trusted driver. Runs inside the deliverable so module resolution matches the
 * project exactly, asks the metering collector for one run per configured
 * dimension, and writes the raw measurements out for scoring elsewhere.
 *
 * Everything this file touches belongs to the submission, so nothing it prints
 * or returns is treated as a verdict: it only transports observations.
 */
import { Ec2InstanceDataGathererService } from './src/microservices/ec2InstanceDataGatherer/ec2InstanceDataGatherer.service.js';
import { StandardMeasurementEntity } from './src/measurement-config/entities/standardMeasurement.entity.js';
import { writeFileSync } from 'node:fs';

type Run = {
    label: string;
    businessID: string;
    dimensionId: string;
    registryBucket: string;
    registryKey: string;
};

const config = JSON.parse(process.argv[2]) as { runs: Run[]; out: string };

// A collector that publishes rather than returning them is just as valid, so
// both routes are observed and whichever one produced rows is transported.
const captured: Array<Record<string, unknown>> = [];
(StandardMeasurementEntity as unknown as Record<string, unknown>).publish = (
    request: Record<string, unknown>,
) => {
    captured.push(request);
    return { message: 'published', id: 'driver', data: [request] };
};

function normalise(row: unknown): Record<string, unknown> {
    const entry = (row ?? {}) as Record<string, unknown>;
    return {
        customerId: entry.customerId,
        dimensionId: entry.dimensionId,
        recordValue: entry.recordValue,
    };
}

async function main() {
    const runs: Record<string, unknown> = {};

    for (const run of config.runs) {
        captured.length = 0;
        const service = new Ec2InstanceDataGathererService() as unknown as Record<string, unknown>;
        const job = {
            data: {
                businessID: run.businessID,
                subject: 'verifier',
                rate: '0 * * * *',
                scheduleParameters: {
                    dimensionType: 'instanceRunningTime',
                    dimensionId: run.dimensionId,
                    registryBucket: run.registryBucket,
                    registryKey: run.registryKey,
                },
            },
        };
        try {
            let returned: unknown;
            if (typeof service.gatherUsage === 'function') {
                try {
                    returned = await (service.gatherUsage as (input: unknown) => Promise<unknown>).call(
                        service,
                        {
                            businessID: run.businessID,
                            dimensionId: run.dimensionId,
                            registryBucket: run.registryBucket,
                            registryKey: run.registryKey,
                        },
                    );
                } catch {
                    returned = undefined;
                }
            }
            let source = Array.isArray(returned) && returned.length ? (returned as unknown[]) : captured.slice();
            if (!source.length) {
                // The collector may only be reachable through the queue entry
                // point, or may want its parameters the way the queue sends
                // them. Either way the measurements it publishes are observed.
                captured.length = 0;
                await (service.readOperationJob as (input: unknown) => Promise<unknown>).call(service, job);
                source = captured.slice();
            }
            runs[run.label] = { ok: true, rows: source.map(normalise) };
        } catch (error) {
            runs[run.label] = {
                ok: false,
                error: String((error as Error)?.message ?? error),
                stack: String((error as Error)?.stack ?? ''),
            };
        }
    }

    writeFileSync(config.out, JSON.stringify({ runs }, null, 2));
}

main().then(
    () => process.exit(0),
    (error) => {
        writeFileSync(config.out, JSON.stringify({ fatal: String(error?.stack ?? error) }, null, 2));
        process.exit(0);
    },
);

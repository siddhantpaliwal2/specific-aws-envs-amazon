/*
 * Trusted driver. Runs inside the deliverable so module resolution matches the
 * project exactly, asks the usage read path for one customer per configured
 * run, and writes the rows out for scoring elsewhere.
 *
 * Everything this file touches belongs to the submission, so nothing it prints
 * or returns is treated as a verdict: it only transports observations.
 */
import { UsageService } from './src/usage/usage.service.js';
import { writeFileSync } from 'node:fs';

type Run = {
    label: string;
    businessID: string;
    customerId: string;
    startTime: string;
    endTime: string;
    offering: Record<string, unknown>;
};

const config = JSON.parse(process.argv[2]) as { runs: Run[]; out: string };

const ROW_CAP = 400;
const DOCUMENT_CAP = 2000;

/** The scalar fields of one object, so nothing unbounded travels. */
function scalars(value: unknown): unknown {
    if (value === null || value === undefined) {
        return value;
    }
    if (typeof value !== 'object') {
        return String(value);
    }
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (entry === null || ['string', 'number', 'boolean'].includes(typeof entry)) {
            copy[key] = entry;
        } else if (entry instanceof Date) {
            // An instant held as a date would reach an HTTP caller as a string.
            copy[key] = entry.toISOString();
        }
    }
    return copy;
}

/**
 * A bucket, plus the metadata group it may be carrying. Either the row or its
 * buckets can be the thing that names the group, so both are transported.
 */
function document(value: unknown): unknown {
    const copy = scalars(value) as Record<string, unknown>;
    const group = (value as Record<string, unknown>)?.metadataGroup;
    if (copy && typeof copy === 'object' && group && typeof group === 'object') {
        copy.metadataGroup = scalars(group);
    }
    return copy;
}

function normalise(row: unknown): Record<string, unknown> {
    const entry = (row ?? {}) as Record<string, unknown>;
    const usage = Array.isArray(entry.usage) ? entry.usage.slice(0, DOCUMENT_CAP) : entry.usage;
    return {
        offeringId: entry.offeringId ?? null,
        dimensionId: entry.dimensionId ?? null,
        metadataGroup: entry.metadataGroup === undefined ? null : scalars(entry.metadataGroup),
        usage: Array.isArray(usage) ? usage.map(document) : null,
    };
}

/**
 * A read may be reachable through the customer usage service or, if the
 * submission arranged it differently, through the aggregation entry point the
 * service calls. Both routes are tried and whichever answers is transported.
 */
async function readUsage(run: Run): Promise<unknown[]> {
    const service = new (UsageService as unknown as { new (): Record<string, unknown> })();
    const request = { customerId: run.customerId, businessID: run.businessID, customer: { offering: run.offering } };
    const overrides = { startTime: run.startTime, endTime: run.endTime };

    if (typeof service.findUsageForCustomer === 'function') {
        const returned = await (
            service.findUsageForCustomer as (request: unknown, overrides: unknown) => Promise<unknown>
        ).call(service, request, overrides);
        if (Array.isArray(returned)) {
            return returned;
        }
    }

    const module = (await import('./src/usage/usageAggregation.event.js')) as Record<string, any>;
    const holder = module.UsageAggregationEvent ?? module.default;
    const returned = await holder.getAggregateUsageForDimension({
        customerId: run.customerId,
        businessID: run.businessID,
        clientID: run.customerId,
        startTime: run.startTime,
        endTime: run.endTime,
        offeringDocument: run.offering,
    });
    return Array.isArray(returned) ? returned : [];
}

async function main() {
    const runs: Record<string, unknown> = {};

    for (const run of config.runs) {
        try {
            const rows = await readUsage(run);
            runs[run.label] = { ok: true, rows: rows.slice(0, ROW_CAP).map(normalise) };
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

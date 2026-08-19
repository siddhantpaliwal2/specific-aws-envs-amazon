/*
 * Trusted driver. Runs inside the deliverable so module resolution matches the
 * project exactly, asks the attribution collector for the business' report, and
 * writes the raw rows out for scoring elsewhere.
 *
 * Everything this file touches belongs to the submission, so nothing it prints
 * or returns is treated as a verdict: it only transports observations.
 */
import { UsageAttributionService } from './src/microservices/usageAttribution/usageAttribution.service.js';
import { writeFileSync } from 'node:fs';

type Run = {
    label: string;
    businessID: string;
    registryBucket: string;
    registryKey: string;
};

const config = JSON.parse(process.argv[2]) as { runs: Run[]; out: string };

// A submission is free to take collaborators on the constructor; the capability
// under test needs none, so a service that cannot be built with no arguments is
// still driven off its prototype rather than being failed for its signature.
function build(): UsageAttributionService {
    try {
        return new (UsageAttributionService as unknown as new () => UsageAttributionService)();
    } catch {
        return Object.create(UsageAttributionService.prototype) as UsageAttributionService;
    }
}

function normalise(row: unknown): Record<string, unknown> {
    const entry = (row ?? {}) as Record<string, unknown>;
    return {
        chargeCode: entry.chargeCode ?? entry.ChargeCode ?? entry.chargecode ?? entry.costCentre,
        quantity: entry.quantity ?? entry.Quantity,
        amount: entry.amount ?? entry.Amount,
        lineCount: entry.lineCount ?? entry.LineCount ?? entry.lines,
    };
}

async function main() {
    const service = build();
    const runs: Record<string, unknown> = {};

    for (const run of config.runs) {
        try {
            const response = await service.attributeSpend({
                businessID: run.businessID,
                registryBucket: run.registryBucket,
                registryKey: run.registryKey,
            });
            const rows = Array.isArray(response) ? response : [];
            runs[run.label] = { ok: true, rows: rows.map(normalise) };
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

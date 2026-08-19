import { getDocument } from '../../utils/aws/s3.js';
import { getInstanceTags } from '../../utils/aws/awsEc2.js';
import { getParameterValue } from '../../utils/aws/awsSSM.js';

const POOL_REFERENCE = 'pool/';
const UNIT_REFERENCE = 'unit/';
const NODE_REFERENCE = 'node/';
const ALIAS_REFERENCE = 'alias/';
const ALIAS_PARAMETER_ROOT = '/metering/attribution/alias/';
const CHARGE_CODE_TAG = 'meteringChargeCode';
const ROLLUP_TAG = 'meteringRollsInto';

/**
 * One pocket of a business' estate. The finance system rewrites the whole set
 * whenever a team moves, so the pools are kept together in a single document
 * rather than one object each.
 */
export class AttributionPool {
    /** The code spend sitting on this pool is booked to. */
    public chargeCode: string;
    /** Where the pool hands its cost on to, when it does not carry it itself. */
    public rollsUpTo?: string;
}

export class AttributionPoolDocument {
    public revision: string;
    public pools: Record<string, AttributionPool>;
}

/**
 * One billing unit. Units change one at a time and are versioned by the finance
 * system on their own, so each keeps its own object beside the pool document.
 */
export class AttributionUnit {
    public unitId: string;
    public chargeCode: string;
    /** Where the unit hands its cost on to, when it does not carry it itself. */
    public parentRef?: string;
}

/**
 * One step of a walk: what the record booked to, and where it hands over next.
 */
type AttributionStep = {
    chargeCode?: string;
    delegate?: string;
};

/**
 * The attribution material a business keeps beside its onboarding record. A
 * reference points at exactly one of four places, and what it finds there may
 * point somewhere else again.
 */
export class AttributionDirectory {
    private readonly bucket: string;
    private readonly prefix: string;
    private readonly pools: Record<string, AttributionPool>;
    private readonly units: Record<string, AttributionUnit> = {};
    private readonly nodes: Record<string, Record<string, string>> = {};
    private readonly aliases: Record<string, string> = {};

    private constructor(bucket: string, prefix: string, pools: Record<string, AttributionPool>) {
        this.bucket = bucket;
        this.prefix = prefix;
        this.pools = pools;
    }

    static async load(bucket: string, prefix: string): Promise<AttributionDirectory> {
        const document = await getDocument<AttributionPoolDocument>(bucket, `${prefix}pools.json`);
        return new AttributionDirectory(bucket, prefix, document?.pools ?? {});
    }

    /**
     * The charge code the attribution reference a usage line carries finally
     * lands on. Hand-offs are followed until a record has none left. A
     * reference the walk has already stood on ends it, which is what keeps a
     * pocket that hands back to something above it from running for ever.
     */
    async chargeCodeFor(reference: string, credentialsFor: (accountId: string) => any): Promise<string> {
        const seen: Record<string, boolean> = {};
        let pointer = reference;
        let chargeCode: string;
        while (pointer && !seen[pointer]) {
            seen[pointer] = true;
            if (pointer.startsWith(ALIAS_REFERENCE)) {
                // eslint-disable-next-line no-await-in-loop
                pointer = await this.aliasTarget(pointer.slice(ALIAS_REFERENCE.length));
                continue;
            }
            // eslint-disable-next-line no-await-in-loop
            const step = await this.stepFor(pointer, credentialsFor);
            if (!step) {
                return chargeCode;
            }
            chargeCode = step.chargeCode ?? chargeCode;
            pointer = step.delegate;
        }
        return chargeCode;
    }

    private async stepFor(reference: string, credentialsFor: (accountId: string) => any): Promise<AttributionStep> {
        if (reference.startsWith(POOL_REFERENCE)) {
            const pool = this.pools[reference.slice(POOL_REFERENCE.length)];
            return pool ? { chargeCode: pool.chargeCode, delegate: pool.rollsUpTo } : undefined;
        }
        if (reference.startsWith(UNIT_REFERENCE)) {
            const unit = await this.unit(reference.slice(UNIT_REFERENCE.length));
            return unit ? { chargeCode: unit.chargeCode, delegate: unit.parentRef } : undefined;
        }
        if (reference.startsWith(NODE_REFERENCE)) {
            const [accountId, region, instanceId] = reference.slice(NODE_REFERENCE.length).split('/');
            if (!accountId || !region || !instanceId) {
                return undefined;
            }
            const tags = await this.nodeTags(accountId, region, instanceId, credentialsFor);
            return { chargeCode: tags[CHARGE_CODE_TAG], delegate: tags[ROLLUP_TAG] };
        }
        return undefined;
    }

    private async unit(name: string): Promise<AttributionUnit> {
        if (this.units[name] === undefined) {
            this.units[name] = await getDocument<AttributionUnit>(this.bucket, `${this.prefix}units/${name}.json`);
        }
        return this.units[name];
    }

    private async nodeTags(
        accountId: string,
        region: string,
        instanceId: string,
        credentialsFor: (accountId: string) => any,
    ): Promise<Record<string, string>> {
        const key = `${accountId}/${region}/${instanceId}`;
        if (this.nodes[key] === undefined) {
            this.nodes[key] = await getInstanceTags(region, credentialsFor(accountId), instanceId);
        }
        return this.nodes[key];
    }

    private async aliasTarget(key: string): Promise<string> {
        if (this.aliases[key] === undefined) {
            this.aliases[key] = await getParameterValue(`${ALIAS_PARAMETER_ROOT}${key}`);
        }
        return this.aliases[key];
    }
}

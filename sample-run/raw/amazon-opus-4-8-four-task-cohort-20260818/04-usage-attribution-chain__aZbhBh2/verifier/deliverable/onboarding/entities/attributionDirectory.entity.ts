import { getDocument } from '../../utils/aws/s3.js';

const POOL_REFERENCE = 'pool/';
const UNIT_REFERENCE = 'unit/';

/**
 * One pocket of a business' estate. The finance system rewrites the whole set
 * whenever a team moves, so the pools are kept together in a single document
 * rather than one object each.
 */
export class AttributionPool {
    /** The code spend sitting on this pool is booked to. */
    public chargeCode: string;
    /**
     * Where this pool's spend is passed on to, when it is passed on at all.
     * Another pool, a unit, an alias or a node.
     * @example "unit/ember"
     */
    public rollsUpTo?: string;
}

export class AttributionPoolDocument {
    public revision: string;
    public pools: Record<string, AttributionPool>;
}

/**
 * A business unit the finance system keeps as its own object beside the pools.
 */
export class AttributionUnit {
    public unitId: string;
    /** The code spend sitting on this unit is booked to. */
    public chargeCode: string;
    /**
     * Where this unit's spend is passed on to, when it is passed on at all.
     * @example "pool/mossgate"
     */
    public parentRef?: string;
}

/**
 * A single owner in the attribution graph: something that carries a charge
 * code and optionally passes its spend on to another owner.
 */
class AttributionNode {
    constructor(public readonly chargeCode: string, public readonly next?: string) {}
}

/**
 * The attribution material a business keeps beside its onboarding record.
 */
export class AttributionDirectory {
    private readonly pools: Record<string, AttributionPool>;
    private readonly units: Record<string, AttributionUnit>;

    private constructor(pools: Record<string, AttributionPool>, units: Record<string, AttributionUnit>) {
        this.pools = pools;
        this.units = units;
    }

    static async load(bucket: string, prefix: string): Promise<AttributionDirectory> {
        const document = await getDocument<AttributionPoolDocument>(bucket, `${prefix}pools.json`);
        const pools = document?.pools ?? {};
        const unitNames = new Set<string>();
        const consider = (reference?: string) => {
            if (reference && reference.startsWith(UNIT_REFERENCE)) {
                unitNames.add(reference.slice(UNIT_REFERENCE.length));
            }
        };
        Object.values(pools).forEach((pool) => consider(pool?.rollsUpTo));

        // A unit can point at another unit, so keep pulling referenced units in
        // until no new names appear.
        const units: Record<string, AttributionUnit> = {};
        const pending = Array.from(unitNames);
        while (pending.length) {
            const name = pending.shift();
            if (name in units) {
                continue;
            }
            // eslint-disable-next-line no-await-in-loop
            const unit = await getDocument<AttributionUnit>(bucket, `${prefix}units/${name}.json`).catch(() => undefined);
            units[name] = unit ?? undefined;
            if (unit?.parentRef && unit.parentRef.startsWith(UNIT_REFERENCE)) {
                pending.push(unit.parentRef.slice(UNIT_REFERENCE.length));
            }
        }

        return new AttributionDirectory(pools, units);
    }

    private nodeFor(reference?: string): AttributionNode | undefined {
        if (!reference) {
            return undefined;
        }
        if (reference.startsWith(POOL_REFERENCE)) {
            const pool = this.pools[reference.slice(POOL_REFERENCE.length)];
            return pool ? new AttributionNode(pool.chargeCode, pool.rollsUpTo) : undefined;
        }
        if (reference.startsWith(UNIT_REFERENCE)) {
            const unit = this.units[reference.slice(UNIT_REFERENCE.length)];
            return unit ? new AttributionNode(unit.chargeCode, unit.parentRef) : undefined;
        }
        // Aliases, nodes and anything else are owners we hold no record for, so
        // the chain settles on the last owner that named a charge code.
        return undefined;
    }

    /**
     * The charge code that ultimately carries a usage line's spend.
     *
     * The line names an owner; that owner may pass its spend on to another
     * owner, and so on. We walk that chain to the final owner and return its
     * charge code. When the chain runs into an owner we hold no record for we
     * settle on the last owner that named a charge code. When the chain repeats
     * we settle on the charge code shared by the owners in that cycle.
     */
    chargeCodeFor(reference: string): string {
        let node = this.nodeFor(reference);
        if (!node) {
            return undefined;
        }
        const seen = new Set<string>([reference]);
        let lastChargeCode = node.chargeCode;
        while (node?.next) {
            if (seen.has(node.next)) {
                // A cycle: every owner in it shares the charge code, so the code
                // we are already sitting on is the one the cycle carries.
                break;
            }
            seen.add(node.next);
            const nextNode = this.nodeFor(node.next);
            if (!nextNode) {
                break;
            }
            node = nextNode;
            lastChargeCode = node.chargeCode;
        }
        return lastChargeCode;
    }
}

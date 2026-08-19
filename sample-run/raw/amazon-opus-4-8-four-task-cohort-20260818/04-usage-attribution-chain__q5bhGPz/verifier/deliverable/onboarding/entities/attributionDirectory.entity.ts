import { getDocument, listDocumentKeys } from '../../utils/aws/s3.js';

const POOL_REFERENCE = 'pool/';
const UNIT_REFERENCE = 'unit/';
const UNITS_PREFIX = 'units/';

/**
 * One pocket of a business' estate. The finance system rewrites the whole set
 * whenever a team moves, so the pools are kept together in a single document
 * rather than one object each.
 */
export class AttributionPool {
    /** The code spend sitting on this pool is booked to. */
    public chargeCode: string;
    /**
     * Where this pool passes its cost on to, when it hands the cost to another
     * owner instead of carrying it itself.
     * @example "unit/ember"
     */
    public rollsUpTo?: string;
}

export class AttributionPoolDocument {
    public revision: string;
    public pools: Record<string, AttributionPool>;
}

/**
 * A business unit the estate rolls its cost up through.
 */
export class AttributionUnit {
    public unitId: string;
    /** The code spend resting on this unit is booked to. */
    public chargeCode: string;
    /**
     * Where this unit passes its cost on to, when it hands the cost to another
     * owner instead of carrying it itself.
     * @example "pool/mossgate"
     */
    public parentRef?: string;
}

/**
 * A single node in the attribution graph: something that carries a charge code
 * and, when it hands its cost on, names the next hop in the chain.
 */
interface AttributionNode {
    chargeCode: string;
    next?: string;
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
        const unitKeys = await listDocumentKeys(bucket, `${prefix}${UNITS_PREFIX}`);
        const units: Record<string, AttributionUnit> = {};
        await Promise.all(
            unitKeys.map(async (key) => {
                const name = key.slice(key.lastIndexOf('/') + 1).replace(/\.json$/, '');
                const unit = await getDocument<AttributionUnit>(bucket, key);
                if (unit) {
                    units[name] = unit;
                }
            }),
        );
        return new AttributionDirectory(document?.pools ?? {}, units);
    }

    /**
     * The single node an attribution reference names, or undefined when the
     * reference points at material we do not hold (for example an alias or a
     * node reference). An unheld reference ends the chain rather than dropping
     * the line.
     */
    private nodeFor(reference: string): AttributionNode | undefined {
        if (reference?.startsWith(POOL_REFERENCE)) {
            const pool = this.pools[reference.slice(POOL_REFERENCE.length)];
            return pool ? { chargeCode: pool.chargeCode, next: pool.rollsUpTo } : undefined;
        }
        if (reference?.startsWith(UNIT_REFERENCE)) {
            const unit = this.units[reference.slice(UNIT_REFERENCE.length)];
            return unit ? { chargeCode: unit.chargeCode, next: unit.parentRef } : undefined;
        }
        return undefined;
    }

    /**
     * The charge code that ultimately carries the spend a usage line starts on.
     *
     * A usage line begins at some attribution reference. That node may carry its
     * own cost or hand it on to another owner through a chain. We follow the
     * chain to the final code that actually carries the spend, never booking to
     * an intermediate node. When a chain repeats we settle on the charge code
     * shared by the cycle. When the chain hands off to material we do not hold,
     * the last node we could resolve carries the spend.
     */
    chargeCodeFor(reference: string): string {
        const chain: Array<{ ref: string; chargeCode: string }> = [];
        const visited = new Set<string>();
        let current = reference;
        let lastChargeCode: string | undefined;

        while (current) {
            if (visited.has(current)) {
                return AttributionDirectory.cycleChargeCode(chain, current);
            }
            visited.add(current);

            const node = this.nodeFor(current);
            if (!node) {
                // The chain hands off to material we do not hold. The last node
                // we resolved is the final owner; if there was none the line is
                // attributed to nothing.
                return lastChargeCode;
            }

            lastChargeCode = node.chargeCode;
            chain.push({ ref: current, chargeCode: node.chargeCode });

            if (!node.next) {
                return node.chargeCode;
            }
            current = node.next;
        }

        return lastChargeCode;
    }

    /**
     * The charge code shared by a cycle. The nodes that form a cycle carry the
     * same charge code, so we return it; if they somehow disagree we fall back
     * to the code of the node the cycle closes on, keeping the choice stable.
     */
    private static cycleChargeCode(chain: Array<{ ref: string; chargeCode: string }>, repeated: string): string {
        const start = chain.findIndex((entry) => entry.ref === repeated);
        const cycle = start >= 0 ? chain.slice(start) : chain;
        const codes = new Set(cycle.map((entry) => entry.chargeCode));
        if (codes.size === 1) {
            return cycle[0].chargeCode;
        }
        const closing = chain.find((entry) => entry.ref === repeated);
        return closing ? closing.chargeCode : chain[chain.length - 1]?.chargeCode;
    }
}

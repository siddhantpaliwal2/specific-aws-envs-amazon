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
     * Where this pool passes its cost on to, when it does not keep it. The
     * reference names another point in the attribution material (another pool,
     * a unit, an alias, a node, ...).
     */
    public rollsUpTo?: string;
}

export class AttributionPoolDocument {
    public revision: string;
    public pools: Record<string, AttributionPool>;
}

/**
 * A business unit kept as its own object beside the pools. It carries a charge
 * code and may itself pass its cost on to a parent point in the material.
 */
export class AttributionUnitDocument {
    public unitId: string;
    public chargeCode: string;
    public parentRef?: string;
}

/**
 * A single resolved point in the attribution material: the code it books to
 * and, when it forwards its cost on, the reference of the next owner.
 */
interface AttributionNode {
    chargeCode: string;
    next?: string;
}

/**
 * The attribution material a business keeps beside its onboarding record.
 */
export class AttributionDirectory {
    private readonly bucket: string;

    private readonly prefix: string;

    private readonly pools: Record<string, AttributionPool>;

    /** Unit documents are fetched one object at a time, so cache what we read. */
    private readonly unitCache: Record<string, AttributionUnitDocument | undefined> = {};

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
     * The charge code named by the attribution reference a usage line carries,
     * ignoring any onward chain. Kept for callers that only want the first hop.
     */
    chargeCodeFor(reference: string): string {
        if (!reference || !reference.startsWith(POOL_REFERENCE)) {
            return undefined;
        }
        return this.pools[reference.slice(POOL_REFERENCE.length)]?.chargeCode;
    }

    /**
     * Resolve a single reference to the point it names: the code it books to
     * and the reference it forwards its cost on to, when it does. References we
     * cannot resolve (a missing document, or a kind of reference that has no
     * document at all, such as an alias or a node) return undefined so the
     * caller treats the previous point as the final owner.
     */
    private async resolveNode(reference: string): Promise<AttributionNode | undefined> {
        if (!reference) {
            return undefined;
        }
        if (reference.startsWith(POOL_REFERENCE)) {
            const pool = this.pools[reference.slice(POOL_REFERENCE.length)];
            return pool ? { chargeCode: pool.chargeCode, next: pool.rollsUpTo } : undefined;
        }
        if (reference.startsWith(UNIT_REFERENCE)) {
            const name = reference.slice(UNIT_REFERENCE.length);
            if (!(name in this.unitCache)) {
                this.unitCache[name] = await getDocument<AttributionUnitDocument>(
                    this.bucket,
                    `${this.prefix}units/${name}.json`,
                ).catch(() => undefined);
            }
            const unit = this.unitCache[name];
            return unit ? { chargeCode: unit.chargeCode, next: unit.parentRef } : undefined;
        }
        // Any other kind of reference (alias, node, ...) has no document to read.
        return undefined;
    }

    /**
     * Walk the chain a usage line's attribution reference starts, following each
     * point's onward reference until the cost comes to rest, and return the
     * charge code that ultimately carries it.
     *
     * The cost comes to rest when a point forwards nowhere, or forwards to a
     * reference we cannot resolve; in either case the last point we did resolve
     * is the final owner. If the chain loops back on itself, the cost is shared
     * by the codes in that loop, so we book it to the code the loop shares.
     */
    async finalChargeCodeFor(reference: string): Promise<string | undefined> {
        if (!reference) {
            return undefined;
        }
        const visited: string[] = [];
        const codeAt: Record<string, string> = {};
        let current = reference;
        let lastCode: string | undefined;

        while (current) {
            if (Object.prototype.hasOwnProperty.call(codeAt, current)) {
                // A cycle: everything from the first sighting of `current` on.
                const cycle = visited.slice(visited.indexOf(current));
                const codes = [...new Set(cycle.map((ref) => codeAt[ref]))].sort();
                return codes[0];
            }
            // eslint-disable-next-line no-await-in-loop
            const node = await this.resolveNode(current);
            if (!node) {
                // Unresolvable onward reference: rest on the last owner we saw.
                return lastCode;
            }
            visited.push(current);
            codeAt[current] = node.chargeCode;
            lastCode = node.chargeCode;
            if (!node.next) {
                return node.chargeCode;
            }
            current = node.next;
        }
        return lastCode;
    }
}

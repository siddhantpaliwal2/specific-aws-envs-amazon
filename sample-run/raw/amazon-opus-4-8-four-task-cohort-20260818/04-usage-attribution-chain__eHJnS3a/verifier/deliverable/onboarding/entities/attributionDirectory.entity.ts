import { getDocument } from '../../utils/aws/s3.js';

const POOL_REFERENCE = 'pool/';

/**
 * One pocket of a business' estate. The finance system rewrites the whole set
 * whenever a team moves, so the pools are kept together in a single document
 * rather than one object each.
 */
export class AttributionPool {
    /** The code spend sitting on this pool is booked to. */
    public chargeCode: string;
}

export class AttributionPoolDocument {
    public revision: string;
    public pools: Record<string, AttributionPool>;
}

/**
 * The attribution material a business keeps beside its onboarding record.
 */
export class AttributionDirectory {
    private readonly pools: Record<string, AttributionPool>;

    private constructor(pools: Record<string, AttributionPool>) {
        this.pools = pools;
    }

    static async load(bucket: string, prefix: string): Promise<AttributionDirectory> {
        const document = await getDocument<AttributionPoolDocument>(bucket, `${prefix}pools.json`);
        return new AttributionDirectory(document?.pools ?? {});
    }

    /**
     * The charge code named by the attribution reference a usage line carries.
     */
    chargeCodeFor(reference: string): string {
        if (!reference || !reference.startsWith(POOL_REFERENCE)) {
            return undefined;
        }
        return this.pools[reference.slice(POOL_REFERENCE.length)]?.chargeCode;
    }
}

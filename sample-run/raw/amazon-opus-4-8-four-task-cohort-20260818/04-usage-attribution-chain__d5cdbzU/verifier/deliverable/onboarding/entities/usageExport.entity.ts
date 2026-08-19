import { getDocument, listDocumentKeys } from '../../utils/aws/s3.js';

/**
 * One metered line as the account's collector wrote it out.
 */
export class UsageExportLine {
    public lineId: string;
    /**
     * The resource the collector measured.
     * @example "i-0a3f19c2d4e5b6708"
     */
    public resourceId: string;
    /**
     * The region the resource was measured in.
     * @example "eu-west-1"
     */
    public region: string;
    /** How much of the dimension the line carries. */
    public quantity: number;
    /** What the line came to in the reporting currency. */
    public amount: number;
    /**
     * Where in the business' attribution material this line starts.
     * @example "pool/aurora-ci"
     */
    public attribution: string;
}

/**
 * One usage export. A collector drops an export into its account's usage
 * bucket every time it finishes a sweep, so an account accumulates one object
 * per sweep and a single export may cover several regions at once.
 */
export class UsageExportBatch {
    public batchId: string;
    public coveringDate: string;
    public lines: Array<UsageExportLine>;
}

export class UsageExport {
    /**
     * Every metered line an account has exported.
     */
    static async linesForAccount(
        bucket: string,
        prefix: string,
        accountId: string,
        credentials = undefined,
    ): Promise<Array<UsageExportLine>> {
        const keys = await listDocumentKeys(bucket, `${prefix}${accountId}/`, credentials);
        const batches = await Promise.all(keys.map((key) => getDocument<UsageExportBatch>(bucket, key, credentials)));
        const lines: Array<UsageExportLine> = [];
        batches.forEach((batch) => {
            (batch?.lines ?? []).forEach((line) => lines.push(line));
        });
        return lines;
    }
}

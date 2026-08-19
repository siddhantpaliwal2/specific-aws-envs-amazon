import { getDocument, listKeys } from '../../utils/aws/s3.js';

/**
 * An AWS account a business has handed us for measurement.
 */
export class MeteredAccount {
    /**
     * The account the metering role lives in.
     * @example "445566778899"
     */
    public accountId: string;
    /**
     * The role we assume to read the account.
     * @example "arn:aws:iam::445566778899:role/metering-metering"
     */
    public roleArn: string;
    /**
     * The external id the role's trust policy asks for, when it asks for one.
     */
    public externalId?: string;
    /**
     * The region the business runs the metered workload in.
     * @example "us-east-1"
     */
    public region: string;
}

/**
 * The onboarding record a business keeps in its metering bucket. It is written
 * by the onboarding flow and read by every collector that has to sweep more
 * than one account.
 */
export class MeteringRegistry {
    public businessID: string;
    /**
     * Key prefix the per customer onboarding records sit under in the same
     * bucket, one object per customer.
     * @example "onboarding/customers/"
     */
    public customerRecordPrefix: string;
    public accounts: Array<MeteredAccount>;

    static async load(bucket: string, key: string): Promise<MeteringRegistry> {
        return getDocument<MeteringRegistry>(bucket, key);
    }
}

/**
 * One account a customer was onboarded against.
 */
export class CustomerAccountLink {
    public accountId: string;
    /**
     * Set when the account was stood up for this customer alone.
     */
    public dedicated?: boolean;
}

/**
 * The per customer half of the onboarding record.
 */
export class CustomerOnboardingRecord {
    public customerId: string;
    public accounts: Array<CustomerAccountLink>;
}

/**
 * The account to customer side of onboarding, indexed for lookup.
 */
export class TenantDirectory {
    private readonly allowed: Record<string, Set<string>> = {};
    private readonly dedicated: Record<string, string> = {};

    constructor(records: Array<CustomerOnboardingRecord>) {
        records.forEach(({ customerId, accounts }) => {
            (accounts ?? []).forEach(({ accountId, dedicated }) => {
                if (!this.allowed[accountId]) {
                    this.allowed[accountId] = new Set<string>();
                }
                this.allowed[accountId].add(customerId);
                if (dedicated) {
                    this.dedicated[accountId] = customerId;
                }
            });
        });
    }

    static async load(bucket: string, registry: MeteringRegistry): Promise<TenantDirectory> {
        const keys = await listKeys(bucket, registry.customerRecordPrefix);
        const records = await Promise.all(keys.map((key) => getDocument<CustomerOnboardingRecord>(bucket, key)));
        return new TenantDirectory(records.filter((record) => record && record.customerId));
    }

    billable(accountId: string, customerId: string): boolean {
        return Boolean(this.allowed[accountId]?.has(customerId));
    }

    standingCustomer(accountId: string): string | undefined {
        return this.dedicated[accountId];
    }

    /**
     * The customers that carry an account's resource, given whatever the
     * resource itself claims. A claim we cannot honour counts for nothing, and
     * a resource claiming nobody falls to whoever the account was stood up for.
     */
    owners(accountId: string, claimed: Array<string>): Array<string> {
        const honoured: Array<string> = [];
        claimed.forEach((customerId) => {
            if (this.billable(accountId, customerId) && !honoured.includes(customerId)) {
                honoured.push(customerId);
            }
        });
        if (honoured.length) {
            return honoured;
        }
        const standing = this.standingCustomer(accountId);
        return standing ? [standing] : [];
    }
}

import { getDocument, listDocumentKeys } from '../../utils/aws/s3.js';

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
 * One entry in a customer's onboarding record naming an account the customer is
 * billable for. `dedicated` marks an account that is set aside for this single
 * customer, so every metered machine in it belongs to the customer no matter
 * what its tags say.
 */
export class CustomerAccount {
    public accountId: string;
    public dedicated?: boolean;
}

/**
 * The onboarding record a business keeps for a single customer in its metering
 * bucket, one object per customer under the registry's customerRecordPrefix. It
 * is the authority on which customers are genuinely billable for which account.
 */
export class CustomerOnboarding {
    public customerId: string;
    public displayName?: string;
    public accounts: Array<CustomerAccount>;

    static async loadAll(bucket: string, prefix: string): Promise<Array<CustomerOnboarding>> {
        const keys = await listDocumentKeys(bucket, prefix);
        return Promise.all(keys.map((key) => getDocument<CustomerOnboarding>(bucket, key)));
    }
}

/**
 * Resolves, for a single AWS account, who is billable for machines in it.
 */
export class AccountBilling {
    /**
     * The customers genuinely onboarded for this account.
     */
    public tenants: Array<string>;
    /**
     * When the account is dedicated, the single customer it belongs to. A
     * dedicated account has exactly one billable customer.
     */
    public dedicatedTo?: string;

    constructor(tenants: Array<string>, dedicatedTo?: string) {
        this.tenants = tenants;
        this.dedicatedTo = dedicatedTo;
    }

    get isDedicated(): boolean {
        return Boolean(this.dedicatedTo);
    }
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

    /**
     * Loads the per customer onboarding records and builds, per account id, the
     * set of billable tenants and whether the account is dedicated to a single
     * customer.
     */
    async billingByAccount(bucket: string): Promise<Record<string, AccountBilling>> {
        const customers = await CustomerOnboarding.loadAll(bucket, this.customerRecordPrefix);
        const tenants: Record<string, Set<string>> = {};
        const dedicatedTo: Record<string, string | undefined> = {};

        for (const customer of customers) {
            for (const account of customer.accounts ?? []) {
                (tenants[account.accountId] ??= new Set<string>()).add(customer.customerId);
                if (account.dedicated) {
                    dedicatedTo[account.accountId] = customer.customerId;
                }
            }
        }

        const billing: Record<string, AccountBilling> = {};
        for (const account of this.accounts) {
            const tenantSet = tenants[account.accountId] ?? new Set<string>();
            // An account is only genuinely dedicated when exactly one customer
            // is onboarded for it. If more than one customer claims the account
            // it is shared, not dedicated, no matter the flag.
            const dedicated =
                dedicatedTo[account.accountId] && tenantSet.size === 1 ? dedicatedTo[account.accountId] : undefined;
            billing[account.accountId] = new AccountBilling([...tenantSet].sort(), dedicated);
        }
        return billing;
    }
}

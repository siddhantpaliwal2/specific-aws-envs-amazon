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
 * How a single customer is onboarded onto one of the business' accounts. This
 * lives inside a {@link CustomerOnboarding} record.
 */
export class CustomerAccountOnboarding {
    public accountId: string;
    /**
     * True when the account is set aside for this one customer. A dedicated
     * account belongs entirely to the customer that reserved it, so every
     * machine in it is theirs no matter what its tags say (or fail to say).
     */
    public dedicated?: boolean;
}

/**
 * The onboarding record a business keeps for a single customer, one object per
 * customer under the registry's {@link MeteringRegistry.customerRecordPrefix}.
 * A customer only becomes billable for an account once such a record onboards
 * them onto it.
 */
export class CustomerOnboarding {
    public customerId: string;
    public displayName?: string;
    public accounts: Array<CustomerAccountOnboarding>;

    /**
     * Load every customer onboarding record sitting beside the account list in
     * the metering bucket. The registry key itself is skipped so only the per
     * customer objects come back.
     */
    static async loadAll(bucket: string, prefix: string): Promise<Array<CustomerOnboarding>> {
        const keys = await listKeys(bucket, prefix);
        const records = await Promise.all(
            keys.filter((key) => !key.endsWith('/')).map((key) => getDocument<CustomerOnboarding>(bucket, key)),
        );
        return records.filter((record) => record && record.customerId);
    }
}

/**
 * How the business' accounts are billed once the customer onboarding records
 * are read against the account list.
 */
export class AccountBilling {
    /**
     * The account this describes.
     */
    public accountId: string;
    /**
     * When set, the account is dedicated to this single customer: every metered
     * machine in it is theirs regardless of tags.
     */
    public dedicatedCustomerId?: string;
    /**
     * The customers genuinely onboarded onto this account. For a shared account
     * a machine's uptime is split evenly among these tenants. Empty means no
     * one is billable for the account and its usage stays off the bill.
     */
    public tenants: Array<string>;
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
     * Read the customer onboarding records that sit beside this registry and
     * work out, for every account, who is billable and how. Dedicated accounts
     * resolve to a single owning customer; shared accounts resolve to the set
     * of onboarded tenants; accounts nobody onboarded resolve to no tenants so
     * their usage stays off the bill.
     */
    static async resolveBilling(registry: MeteringRegistry, bucket: string): Promise<Map<string, AccountBilling>> {
        const customers = await CustomerOnboarding.loadAll(bucket, registry.customerRecordPrefix);
        const billing = new Map<string, AccountBilling>();
        (registry.accounts ?? []).forEach((account) => {
            billing.set(account.accountId, { accountId: account.accountId, tenants: [] });
        });
        customers.forEach((customer) => {
            (customer.accounts ?? []).forEach((onboarding) => {
                const account = billing.get(onboarding.accountId);
                if (!account) {
                    return;
                }
                if (!account.tenants.includes(customer.customerId)) {
                    account.tenants.push(customer.customerId);
                }
                if (onboarding.dedicated) {
                    account.dedicatedCustomerId = customer.customerId;
                }
            });
        });
        billing.forEach((account) => {
            account.tenants.sort();
        });
        return billing;
    }
}

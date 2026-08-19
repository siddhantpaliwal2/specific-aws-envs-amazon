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
 * A single account listed on a customer's onboarding record. When the account
 * is dedicated to the customer the record flags it so; otherwise the account is
 * shared and the customer is one of possibly several tenants on it.
 */
export class CustomerOnboardingAccount {
    public accountId: string;
    /**
     * True when this customer is the sole tenant the business runs in the
     * account. Everything metered in a dedicated account belongs to the
     * customer regardless of tags.
     */
    public dedicated?: boolean;
}

/**
 * The per customer onboarding record kept in the metering bucket, one object per
 * customer, under the registry's {@link MeteringRegistry.customerRecordPrefix}.
 * These records are the source of truth for who is billable in each account.
 */
export class CustomerOnboarding {
    public customerId: string;
    public displayName?: string;
    public accounts: Array<CustomerOnboardingAccount>;
}

/**
 * How an account attributes its metered usage, derived from the customer
 * onboarding records.
 *
 * - `dedicated` names the single customer who owns everything metered in the
 *   account, regardless of tags.
 * - `tenants` is the set of customers genuinely onboarded for a shared account;
 *   usage is divided evenly between them. When empty, usage is unplaceable and
 *   stays off the bill.
 */
export class AccountAttribution {
    public dedicatedCustomerId?: string;
    public tenants: Array<string> = [];
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
        const document = await getDocument<MeteringRegistry>(bucket, key);
        return Object.assign(new MeteringRegistry(), document);
    }

    /**
     * Read every per customer onboarding record living beneath
     * {@link customerRecordPrefix} in the given bucket.
     */
    async loadCustomerOnboardings(bucket: string): Promise<Array<CustomerOnboarding>> {
        if (!this.customerRecordPrefix) {
            return [];
        }
        const keys = await listDocumentKeys(bucket, this.customerRecordPrefix);
        return Promise.all(keys.map((key) => getDocument<CustomerOnboarding>(bucket, key)));
    }

    /**
     * Build, per account id, who its metered usage should be attributed to.
     *
     * A customer that flags an account dedicated becomes that account's sole
     * owner. Every other customer that lists an account becomes a shared tenant
     * of it. Accounts that no billable customer claims end up with neither a
     * dedicated owner nor tenants, leaving their usage off the bill.
     */
    static buildAttribution(customers: Array<CustomerOnboarding>): Record<string, AccountAttribution> {
        const attribution: Record<string, AccountAttribution> = {};
        const ensure = (accountId: string): AccountAttribution => {
            if (!attribution[accountId]) {
                attribution[accountId] = new AccountAttribution();
            }
            return attribution[accountId];
        };
        customers.forEach((customer) => {
            (customer.accounts ?? []).forEach((account) => {
                const record = ensure(account.accountId);
                if (account.dedicated) {
                    record.dedicatedCustomerId = customer.customerId;
                } else if (!record.tenants.includes(customer.customerId)) {
                    record.tenants.push(customer.customerId);
                }
            });
        });
        Object.values(attribution).forEach((record) => record.tenants.sort());
        return attribution;
    }
}

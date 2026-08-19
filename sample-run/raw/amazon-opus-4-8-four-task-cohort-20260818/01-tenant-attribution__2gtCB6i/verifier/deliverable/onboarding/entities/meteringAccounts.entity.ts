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
 * The account link a customer's onboarding record carries, one per account the
 * customer is billable in.
 */
export class OnboardedAccount {
    /**
     * The account the customer is onboarded into.
     * @example "445566778899"
     */
    public accountId: string;
    /**
     * When set, the whole account is dedicated to this customer: every metered
     * machine in it belongs to the customer regardless of how it is tagged.
     */
    public dedicated?: boolean;
}

/**
 * A single customer's onboarding record, one object per customer under the
 * registry's customerRecordPrefix. It is the source of truth for which
 * customers are genuinely billable in which accounts.
 */
export class CustomerOnboarding {
    /**
     * The billable customer.
     * @example "cus_harbor"
     */
    public customerId: string;
    public displayName?: string;
    /**
     * Every account the customer is onboarded into.
     */
    public accounts: Array<OnboardedAccount>;

    static async load(bucket: string, key: string): Promise<CustomerOnboarding> {
        return getDocument<CustomerOnboarding>(bucket, key);
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

    /**
     * The customer onboarding records that live beside this registry. Populated
     * by load so callers can resolve which customers are billable in which
     * accounts.
     */
    public customers: Array<CustomerOnboarding> = [];

    static async load(bucket: string, key: string): Promise<MeteringRegistry> {
        const raw = await getDocument<MeteringRegistry>(bucket, key);
        const registry = Object.assign(new MeteringRegistry(), raw);
        registry.customers = await MeteringRegistry.loadCustomers(bucket, registry.customerRecordPrefix);
        return registry;
    }

    private static async loadCustomers(bucket: string, prefix: string): Promise<Array<CustomerOnboarding>> {
        if (!prefix) {
            return [];
        }
        const keys = await listDocumentKeys(bucket, prefix);
        return Promise.all(keys.map((key) => CustomerOnboarding.load(bucket, key)));
    }

    /**
     * The customers onboarded (billable) in an account.
     */
    onboardedCustomers(accountId: string): Array<CustomerOnboarding> {
        return this.customers.filter((customer) =>
            (customer.accounts ?? []).some((link) => link.accountId === accountId),
        );
    }

    /**
     * The customer an account is dedicated to, if any. An account is dedicated
     * only when exactly one onboarded customer claims it as dedicated.
     */
    dedicatedCustomer(accountId: string): CustomerOnboarding | undefined {
        const owners = this.customers.filter((customer) =>
            (customer.accounts ?? []).some((link) => link.accountId === accountId && link.dedicated),
        );
        return owners.length === 1 ? owners[0] : undefined;
    }
}

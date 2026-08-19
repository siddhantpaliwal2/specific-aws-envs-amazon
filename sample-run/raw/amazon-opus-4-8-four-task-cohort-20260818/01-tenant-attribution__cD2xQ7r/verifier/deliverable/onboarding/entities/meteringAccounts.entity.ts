import { getDocument, listDocuments } from '../../utils/aws/s3.js';

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
 * How a single customer is onboarded onto a single account.
 */
export class CustomerAccountEnrollment {
    /**
     * The account the customer is onboarded onto.
     * @example "445566778899"
     */
    public accountId: string;
    /**
     * Whether the account is dedicated to this customer. When an account is
     * dedicated to a customer every metered machine in it belongs to that
     * customer, whatever its tags say (including when they name no customer at
     * all).
     */
    public dedicated?: boolean;
}

/**
 * A per customer onboarding record kept in the metering bucket beside the
 * account list. These records — not the instance tags — decide which customers
 * are billable, which accounts each customer is onboarded onto and which
 * accounts are dedicated to a single customer.
 */
export class CustomerRecord {
    public customerId: string;
    public displayName?: string;
    public accounts: Array<CustomerAccountEnrollment>;
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
     * Loads every per customer onboarding record that sits under
     * {@link customerRecordPrefix} in the given bucket. These records identify
     * the billable customers.
     */
    static async loadCustomers(bucket: string, customerRecordPrefix: string): Promise<Array<CustomerRecord>> {
        const keys = await listDocuments(bucket, customerRecordPrefix);
        const records = await Promise.all(keys.map((key) => getDocument<CustomerRecord>(bucket, key)));
        return records.filter((record) => record && record.customerId);
    }
}

/**
 * Answers, for every account, which customers may be billed for usage in it and
 * whether the account is dedicated to a single customer. Built from the per
 * customer onboarding records so that instance tags never widen who is billed.
 */
export class OnboardingDirectory {
    private readonly enrollments = new Map<string, Set<string>>();
    private readonly dedications = new Map<string, Set<string>>();

    static fromCustomers(customers: Array<CustomerRecord>): OnboardingDirectory {
        const directory = new OnboardingDirectory();
        customers.forEach((customer) => {
            (customer.accounts ?? []).forEach((enrollment) => {
                if (!enrollment || !enrollment.accountId) {
                    return;
                }
                const onboarded = directory.enrollments.get(enrollment.accountId) ?? new Set<string>();
                onboarded.add(customer.customerId);
                directory.enrollments.set(enrollment.accountId, onboarded);

                if (enrollment.dedicated) {
                    const dedicated = directory.dedications.get(enrollment.accountId) ?? new Set<string>();
                    dedicated.add(customer.customerId);
                    directory.dedications.set(enrollment.accountId, dedicated);
                }
            });
        });
        return directory;
    }

    /**
     * The customers genuinely onboarded for an account, sorted for stable
     * output.
     */
    onboardedCustomers(accountId: string): Array<string> {
        return Array.from(this.enrollments.get(accountId) ?? []).sort();
    }

    /**
     * Whether a customer is genuinely onboarded for an account.
     */
    isOnboarded(accountId: string, customerId: string): boolean {
        return this.enrollments.get(accountId)?.has(customerId) ?? false;
    }

    /**
     * The single customer an account is dedicated to, or undefined when the
     * account is shared. An account is dedicated to a customer when its
     * onboarding marks it dedicated for exactly that one customer, or, absent an
     * explicit flag, when exactly one customer is onboarded for it.
     */
    dedicatedCustomer(accountId: string): string | undefined {
        const flagged = Array.from(this.dedications.get(accountId) ?? []);
        if (flagged.length === 1) {
            return flagged[0];
        }
        if (flagged.length > 1) {
            // Conflicting onboarding: more than one customer claims a dedicated
            // account. It cannot be dedicated to any single one of them.
            return undefined;
        }
        const onboarded = this.onboardedCustomers(accountId);
        return onboarded.length === 1 ? onboarded[0] : undefined;
    }
}

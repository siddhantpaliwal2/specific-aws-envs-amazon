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
 * A single account entry inside a customer's onboarding record. It says the
 * customer is billable for the named account and, when a dedicated account, that
 * every metered machine in it belongs to that one customer.
 */
export class CustomerAccountEnrollment {
    public accountId: string;
    /**
     * True when the customer has the account to itself. Every metered machine in
     * a dedicated account belongs to that customer no matter what its tags say.
     */
    public dedicated?: boolean;
}

/**
 * The onboarding record a business keeps per customer in its metering bucket,
 * one object under {@link MeteringRegistry.customerRecordPrefix}. It names the
 * customer and the accounts they are genuinely onboarded (and therefore
 * billable) for.
 */
export class CustomerOnboardingRecord {
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
     * Load every per customer onboarding record sitting under the registry's
     * customer prefix. The registry key itself is skipped so a prefix that
     * happens to also cover the registry object does not get parsed as a
     * customer record.
     */
    async loadCustomerRecords(bucket: string, registryKey?: string): Promise<Array<CustomerOnboardingRecord>> {
        const keys = await listDocumentKeys(bucket, this.customerRecordPrefix);
        const records = await Promise.all(
            keys
                .filter((key) => key !== registryKey && !key.endsWith('/'))
                .map((key) => getDocument<CustomerOnboardingRecord>(bucket, key)),
        );
        return records.filter((record) => record && record.customerId);
    }
}

/**
 * Resolves who a metered machine belongs to, using the per customer onboarding
 * records to decide which accounts are dedicated and which customers are
 * genuinely onboarded for each account.
 */
export class AccountAttribution {
    private readonly dedicatedOwner: Map<string, string>;
    private readonly onboardedTenants: Map<string, Set<string>>;

    constructor(records: Array<CustomerOnboardingRecord>) {
        this.dedicatedOwner = new Map();
        this.onboardedTenants = new Map();
        records.forEach((record) => {
            (record.accounts ?? []).forEach((enrollment) => {
                const tenants = this.onboardedTenants.get(enrollment.accountId) ?? new Set<string>();
                tenants.add(record.customerId);
                this.onboardedTenants.set(enrollment.accountId, tenants);
                if (enrollment.dedicated) {
                    this.dedicatedOwner.set(enrollment.accountId, record.customerId);
                }
            });
        });
    }

    /**
     * The customers a machine's uptime should be credited to and the share each
     * one receives (shares sum to one). Empty when the usage is unplaceable and
     * therefore stays off the bill.
     *
     * - A machine in an account dedicated to one customer belongs entirely to
     *   that customer regardless of the tags, including when they name none.
     * - A machine in a shared account is divided evenly among the customers its
     *   tags name that are genuinely onboarded for the account. Names that are
     *   not onboarded, and machines that name no onboarded customer, stay off
     *   the bill.
     */
    resolve(accountId: string, taggedCustomerIds: Array<string>): Array<{ customerId: string; share: number }> {
        const dedicatedTo = this.dedicatedOwner.get(accountId);
        if (dedicatedTo) {
            return [{ customerId: dedicatedTo, share: 1 }];
        }
        const onboarded = this.onboardedTenants.get(accountId) ?? new Set<string>();
        const billable = Array.from(
            new Set(taggedCustomerIds.filter((customerId) => onboarded.has(customerId))),
        ).sort();
        if (billable.length === 0) {
            return [];
        }
        const share = 1 / billable.length;
        return billable.map((customerId) => ({ customerId, share }));
    }
}

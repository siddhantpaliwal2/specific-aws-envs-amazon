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
 * How a single customer is onboarded onto one AWS account. Written into the
 * per customer onboarding record.
 */
export class CustomerAccountOnboarding {
    /**
     * The account the customer is onboarded onto.
     * @example "445566778899"
     */
    public accountId: string;
    /**
     * True when the account is dedicated to this single customer. Every metered
     * machine in a dedicated account belongs to that customer regardless of
     * which customer (if any) its tags name.
     */
    public dedicated?: boolean;
}

/**
 * The per customer onboarding record a business keeps in its metering bucket,
 * one object per customer under the registry's customerRecordPrefix. These are
 * the records that identify billable customers.
 */
export class CustomerOnboarding {
    public customerId: string;
    public displayName?: string;
    public accounts: Array<CustomerAccountOnboarding>;

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

    static async load(bucket: string, key: string): Promise<MeteringRegistry> {
        return Object.assign(new MeteringRegistry(), await getDocument<MeteringRegistry>(bucket, key));
    }

    /**
     * Load every per customer onboarding record kept under this registry's
     * customerRecordPrefix in the same bucket. These records identify the
     * billable customers for each account.
     */
    async loadCustomers(bucket: string): Promise<Array<CustomerOnboarding>> {
        const keys = await listDocumentKeys(bucket, this.customerRecordPrefix);
        return Promise.all(keys.map((key) => CustomerOnboarding.load(bucket, key)));
    }
}

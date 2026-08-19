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
 * One of the accounts a customer has been onboarded onto, as recorded in the
 * customer's onboarding record.
 */
export class CustomerAccountAssociation {
    /**
     * The account this customer is onboarded onto.
     * @example "445566778899"
     */
    public accountId: string;
    /**
     * When true the whole account is dedicated to this single customer, so
     * every metered machine in it belongs to the customer no matter what its
     * tags say (or fail to say).
     */
    public dedicated?: boolean;
}

/**
 * The onboarding record a business keeps for one of its customers, one object
 * per customer under the registry's customerRecordPrefix. It is the source of
 * truth for who is billable and on which accounts.
 */
export class CustomerRecord {
    public customerId: string;
    public displayName?: string;
    public accounts: Array<CustomerAccountAssociation>;
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
        const plain = await getDocument<MeteringRegistry>(bucket, key);
        return Object.assign(new MeteringRegistry(), plain);
    }

    /**
     * Loads every per customer onboarding record that lives under this
     * registry's customerRecordPrefix in the given bucket. These records
     * identify the billable customers and the accounts each is onboarded onto.
     */
    async loadCustomerRecords(bucket: string): Promise<Array<CustomerRecord>> {
        return MeteringRegistry.loadCustomerRecords(bucket, this.customerRecordPrefix);
    }

    /**
     * Loads every per customer onboarding record that lives under the given
     * prefix in the bucket. These records identify the billable customers and
     * the accounts each is onboarded onto.
     */
    static async loadCustomerRecords(bucket: string, customerRecordPrefix: string): Promise<Array<CustomerRecord>> {
        const keys = await listDocumentKeys(bucket, customerRecordPrefix);
        const recordKeys = keys.filter((key) => key !== customerRecordPrefix);
        return Promise.all(recordKeys.map((key) => getDocument<CustomerRecord>(bucket, key)));
    }
}

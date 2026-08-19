import { Ec2InstanceDataGathererService } from './ec2InstanceDataGatherer.service.js';
import * as s3 from '../../utils/aws/s3.js';
import * as awsEc2 from '../../utils/aws/awsEc2.js';

const INCREMENT = 0.08333333;
const DIM = 'dim-uptime';

const registry = {
    businessID: 'biz',
    customerRecordPrefix: 'onboarding/customers/',
    accounts: [
        { accountId: 'acct-dedicated', roleArn: 'r1', region: 'us-east-1' },
        { accountId: 'acct-shared', roleArn: 'r2', region: 'us-east-1' },
        { accountId: 'acct-orphan', roleArn: 'r3', region: 'us-east-1' },
    ],
};

const customers = {
    'onboarding/customers/cus_a.json': {
        customerId: 'cus_a',
        accounts: [{ accountId: 'acct-dedicated', dedicated: true }, { accountId: 'acct-shared' }],
    },
    'onboarding/customers/cus_b.json': {
        customerId: 'cus_b',
        accounts: [{ accountId: 'acct-shared' }],
    },
};

const instancesByAccount: Record<string, any[]> = {
    'acct-dedicated': [
        {
            InstanceId: 'i-d1',
            InstanceType: 't3.small',
            Tags: [
                { Key: 'meteringDimensionId', Value: DIM },
                { Key: 'meteringCustomerId', Value: 'cus_a' },
            ],
        },
        // untagged customer, still belongs to the dedicated owner
        { InstanceId: 'i-d2', InstanceType: 't3.small', Tags: [{ Key: 'meteringDimensionId', Value: DIM }] },
        // tagged as a DIFFERENT customer, still belongs to the dedicated owner
        {
            InstanceId: 'i-d3',
            InstanceType: 't3.small',
            Tags: [
                { Key: 'meteringDimensionId', Value: DIM },
                { Key: 'meteringCustomerId', Value: 'cus_b' },
            ],
        },
    ],
    'acct-shared': [
        {
            InstanceId: 'i-s1',
            InstanceType: 't3.small',
            Tags: [
                { Key: 'meteringDimensionId', Value: DIM },
                { Key: 'meteringCustomerId', Value: 'cus_a' },
            ],
        },
        { InstanceId: 'i-s2', InstanceType: 't3.small', Tags: [{ Key: 'meteringDimensionId', Value: DIM }] },
        // tagged as a customer NOT onboarded onto this account: ignored, still split evenly
        {
            InstanceId: 'i-s3',
            InstanceType: 't3.small',
            Tags: [
                { Key: 'meteringDimensionId', Value: DIM },
                { Key: 'meteringCustomerId', Value: 'cus_ghost' },
            ],
        },
    ],
    'acct-orphan': [
        // nobody onboarded onto this account -> unplaceable, off the bill
        { InstanceId: 'i-o1', InstanceType: 't3.small', Tags: [{ Key: 'meteringDimensionId', Value: DIM }] },
    ],
};

describe('Ec2InstanceDataGathererService.gatherUsage', () => {
    let svc: Ec2InstanceDataGathererService;

    beforeEach(() => {
        svc = new Ec2InstanceDataGathererService();
        jest.spyOn(s3, 'getDocument').mockImplementation(async (_bucket: string, key: string) => {
            if (key === 'registry.json') return registry as any;
            return customers[key] as any;
        });
        jest.spyOn(s3, 'listKeys').mockResolvedValue(Object.keys(customers));
        jest.spyOn(awsEc2, 'getInstanceWithFilters').mockImplementation(async (region: string, _creds: any) => {
            // resolve which account by matching region call ordering is fragile;
            // instead the account is identified by role via a closure below.
            return [] as any;
        });
    });

    afterEach(() => jest.restoreAllMocks());

    const runFor = (accountInstances: Record<string, any[]>) => {
        const roleToAccount: Record<string, string> = {
            r1: 'acct-dedicated',
            r2: 'acct-shared',
            r3: 'acct-orphan',
        };
        (awsEc2.getInstanceWithFilters as jest.Mock).mockImplementation(async () => []);
        // reimplement readAccount path by mocking per-role using credential params is hard;
        // instead we stub getInstanceWithFilters based on call order of accounts.
        let idx = 0;
        const order = ['acct-dedicated', 'acct-shared', 'acct-orphan'];
        (awsEc2.getInstanceWithFilters as jest.Mock).mockImplementation(async () => {
            const acct = order[idx++];
            return accountInstances[acct] ?? [];
        });
        return svc.gatherUsage({
            businessID: 'biz',
            dimensionId: DIM,
            registryBucket: 'bucket',
            registryKey: 'registry.json',
        });
    };

    it('applies dedicated, shared and orphan rules', async () => {
        const measurements = await runFor(instancesByAccount);
        const byCustomer = Object.fromEntries(measurements.map((m) => [m.customerId, m]));

        // Dedicated account: all 3 machines to cus_a regardless of tags.
        // Shared account: 3 machines split evenly between cus_a and cus_b.
        expect(Object.keys(byCustomer).sort()).toEqual(['cus_a', 'cus_b']);

        expect(byCustomer.cus_a.recordValue).toBeCloseTo(3 * INCREMENT + 3 * (INCREMENT / 2), 8);
        expect(byCustomer.cus_b.recordValue).toBeCloseTo(3 * (INCREMENT / 2), 8);

        expect(byCustomer.cus_a.metadata.instanceIds).toBe('i-d1,i-d2,i-d3,i-s1,i-s2,i-s3');
        expect(byCustomer.cus_b.metadata.instanceIds).toBe('i-s1,i-s2,i-s3');

        // cus_ghost tagged instance never becomes billable, orphan account excluded.
        expect(byCustomer.cus_ghost).toBeUndefined();
    });

    it('drops all usage when nobody is onboarded onto any swept account', async () => {
        const measurements = await runFor({
            'acct-dedicated': [],
            'acct-shared': [],
            'acct-orphan': instancesByAccount['acct-orphan'],
        });
        expect(measurements).toHaveLength(0);
    });
});

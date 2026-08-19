import { jest } from '@jest/globals';
import { Ec2InstanceDataGathererService } from './ec2InstanceDataGatherer.service.js';
import * as s3 from '../../utils/aws/s3.js';
import * as ec2 from '../../utils/aws/awsEc2.js';

const INCREMENT = 0.08333333;

const registry = {
    businessID: 'biz-cadence',
    customerRecordPrefix: 'onboarding/customers/',
    accounts: [
        { accountId: 'dedicated-acct', roleArn: 'arn:dedicated', externalId: '', region: 'us-east-1' },
        { accountId: 'shared-acct', roleArn: 'arn:shared', externalId: '', region: 'us-east-1' },
    ],
};

const customers: Record<string, unknown> = {
    'onboarding/customers/harbor.json': {
        customerId: 'cus_harbor',
        accounts: [{ accountId: 'dedicated-acct', dedicated: true }, { accountId: 'shared-acct' }],
    },
    'onboarding/customers/lattice.json': {
        customerId: 'cus_lattice',
        accounts: [{ accountId: 'shared-acct' }],
    },
};

const instancesByRole: Record<string, Array<unknown>> = {
    'arn:dedicated': [
        // Dedicated account: all belong to the single customer regardless of tags.
        tag('d-1', { meteringCustomerId: 'cus_harbor', meteringDimensionId: 'dim' }),
        tag('d-2', { meteringDimensionId: 'dim' }), // no customer tag
        tag('d-3', { meteringCustomerId: 'cus_lattice', meteringDimensionId: 'dim' }), // wrong tag, still Harbor's
    ],
    'arn:shared': [
        tag('s-1', { meteringCustomerId: 'cus_harbor,cus_lattice', meteringDimensionId: 'dim' }), // split evenly
        tag('s-2', { meteringDimensionId: 'dim' }), // unplaceable -> off the bill
        tag('s-3', { meteringCustomerId: 'cus_lattice', meteringDimensionId: 'dim' }), // Lattice only
        tag('s-4', { meteringCustomerId: 'cus_ghost', meteringDimensionId: 'dim' }), // not onboarded -> off the bill
    ],
};

function tag(id: string, kv: Record<string, string>) {
    return {
        InstanceId: id,
        InstanceType: 't3.micro',
        Tags: Object.entries(kv).map(([Key, Value]) => ({ Key, Value })),
    };
}

describe('Ec2InstanceDataGathererService attribution rules', () => {
    let service: Ec2InstanceDataGathererService;

    beforeEach(() => {
        service = new Ec2InstanceDataGathererService();
        jest.spyOn(s3, 'getDocument').mockImplementation(async (_bucket: string, key: string) => {
            if (key === 'onboarding/registry.json') return registry as never;
            return customers[key] as never;
        });
        jest.spyOn(s3, 'listDocumentKeys').mockResolvedValue(Object.keys(customers));
        jest.spyOn(ec2, 'getInstanceWithFilters').mockImplementation(async (_region, creds) => {
            // fromTemporaryCredentials returns an object; identify via roleArn we stashed.
            return [] as never;
        });
    });

    afterEach(() => jest.restoreAllMocks());

    it('applies dedicated, shared-split, and off-bill rules', async () => {
        // Route by role arn: mock readAccount indirectly through getInstanceWithFilters
        // We resolve which account by matching the region call order using a counter.
        let call = 0;
        const roleOrder = ['arn:dedicated', 'arn:shared'];
        jest.spyOn(ec2, 'getInstanceWithFilters').mockImplementation(async () => {
            const role = roleOrder[call++];
            return instancesByRole[role] as never;
        });

        const results = await service.gatherUsage({
            businessID: 'biz-cadence',
            dimensionId: 'dim',
            registryBucket: 'metering-metering-cadence',
            registryKey: 'onboarding/registry.json',
        });

        const byCustomer = Object.fromEntries(results.map((r) => [r.customerId, r.recordValue]));

        // Harbor: 3 dedicated instances + 0.5 shared split
        expect(byCustomer['cus_harbor']).toBeCloseTo(3.5 * INCREMENT, 6);
        // Lattice: 0.5 shared split + 1 solo shared
        expect(byCustomer['cus_lattice']).toBeCloseTo(1.5 * INCREMENT, 6);
        // No ghost / no bogus combined id
        expect(byCustomer['cus_ghost']).toBeUndefined();
        expect(byCustomer['cus_harbor,cus_lattice']).toBeUndefined();
        expect(Object.keys(byCustomer).sort()).toEqual(['cus_harbor', 'cus_lattice']);
    });
});

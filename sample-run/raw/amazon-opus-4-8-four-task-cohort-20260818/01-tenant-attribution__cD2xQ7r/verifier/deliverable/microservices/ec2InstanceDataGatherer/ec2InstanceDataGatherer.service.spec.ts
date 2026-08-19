import { Ec2InstanceDataGathererService } from './ec2InstanceDataGatherer.service.js';
import { MeteringRegistry } from '../../onboarding/entities/meteringAccounts.entity.js';
import * as awsEc2 from '../../utils/aws/awsEc2.js';

jest.mock('@aws-sdk/credential-providers', () => ({
    fromTemporaryCredentials: () => ({}),
}));

const INCREMENT = 0.08333333;

const tag = (customerId?: string) => {
    const tags = [{ Key: 'meteringDimensionId', Value: 'dim-uptime-sandbox' }];
    if (customerId !== undefined) {
        tags.push({ Key: 'meteringCustomerId', Value: customerId });
    }
    return tags;
};

describe('Ec2InstanceDataGathererService gatherUsage attribution', () => {
    const DEDICATED = '100000000011';
    const SHARED = '100000000022';

    beforeEach(() => {
        jest.restoreAllMocks();
        jest.spyOn(MeteringRegistry, 'load').mockResolvedValue({
            businessID: 'biz-cadence',
            customerRecordPrefix: 'onboarding/customers/',
            accounts: [
                { accountId: DEDICATED, roleArn: 'arn:1', externalId: 'e1', region: 'us-east-1' },
                { accountId: SHARED, roleArn: 'arn:2', externalId: 'e2', region: 'us-east-1' },
            ],
        } as MeteringRegistry);
        jest.spyOn(MeteringRegistry, 'loadCustomers').mockResolvedValue([
            { customerId: 'cus_harbor', accounts: [{ accountId: DEDICATED, dedicated: true }, { accountId: SHARED }] },
            { customerId: 'cus_lattice', accounts: [{ accountId: SHARED }] },
        ]);
    });

    const runFor = (byAccount: Record<string, any[]>) => {
        // Accounts are swept in registry order (DEDICATED then SHARED); return
        // each account's instance list in turn.
        const queue = [byAccount[DEDICATED] ?? [], byAccount[SHARED] ?? []];
        jest.spyOn(awsEc2, 'getInstanceWithFilters').mockImplementation(() => Promise.resolve(queue.shift() ?? []));
        return new Ec2InstanceDataGathererService().gatherUsage({
            businessID: 'biz-cadence',
            dimensionId: 'dim-uptime-sandbox',
            registryBucket: 'b',
            registryKey: 'k',
        });
    };

    it('bills a dedicated account to its customer regardless of tags', async () => {
        const results = await runFor({
            [DEDICATED]: [
                { InstanceId: 'i-1', InstanceType: 'm5.large', Tags: tag('cus_harbor') },
                { InstanceId: 'i-2', InstanceType: 'm5.large', Tags: tag() }, // no customer tag
                { InstanceId: 'i-3', InstanceType: 'm5.large', Tags: tag('cus_lattice') }, // wrong tag
            ],
        });
        expect(results).toHaveLength(1);
        expect(results[0].customerId).toBe('cus_harbor');
        expect(results[0].recordValue).toBeCloseTo(3 * INCREMENT);
    });

    it('splits shared uptime evenly among onboarded tagged customers', async () => {
        const results = await runFor({
            [SHARED]: [{ InstanceId: 'i-11', InstanceType: 'm6i.large', Tags: tag('cus_harbor,cus_lattice') }],
        });
        const byId = Object.fromEntries(results.map((r) => [r.customerId, r.recordValue]));
        expect(byId['cus_harbor']).toBeCloseTo(0.5 * INCREMENT);
        expect(byId['cus_lattice']).toBeCloseTo(0.5 * INCREMENT);
    });

    it('drops shared usage that names no onboarded customer', async () => {
        const results = await runFor({
            [SHARED]: [
                { InstanceId: 'i-a', InstanceType: 'm6i.large', Tags: tag() }, // untagged
                { InstanceId: 'i-b', InstanceType: 'm6i.large', Tags: tag('cus_ghost') }, // not onboarded
            ],
        });
        expect(results).toHaveLength(0);
    });

    it('ignores non-onboarded customers when splitting a shared machine', async () => {
        const results = await runFor({
            [SHARED]: [{ InstanceId: 'i-c', InstanceType: 'm6i.large', Tags: tag('cus_harbor,cus_ghost') }],
        });
        expect(results).toHaveLength(1);
        expect(results[0].customerId).toBe('cus_harbor');
        expect(results[0].recordValue).toBeCloseTo(INCREMENT);
    });
});

import { jest } from '@jest/globals';
import { MeteringRegistry } from './meteringAccounts.entity.js';
import * as s3 from '../../utils/aws/s3.js';

describe('MeteringRegistry.billingByAccount', () => {
    afterEach(() => jest.restoreAllMocks());

    it('marks single-customer dedicated accounts and lists shared tenants', async () => {
        const registry = Object.assign(new MeteringRegistry(), {
            businessID: 'biz',
            customerRecordPrefix: 'onboarding/customers/',
            accounts: [
                { accountId: 'dedicated', roleArn: '', region: 'us-east-1' },
                { accountId: 'shared', roleArn: '', region: 'us-east-1' },
                { accountId: 'orphan', roleArn: '', region: 'us-east-1' },
            ],
        });
        const customers: Record<string, unknown> = {
            'onboarding/customers/harbor.json': {
                customerId: 'cus_harbor',
                accounts: [{ accountId: 'dedicated', dedicated: true }, { accountId: 'shared' }],
            },
            'onboarding/customers/lattice.json': {
                customerId: 'cus_lattice',
                accounts: [{ accountId: 'shared' }],
            },
        };
        jest.spyOn(s3, 'listDocumentKeys').mockResolvedValue(Object.keys(customers));
        jest.spyOn(s3, 'getDocument').mockImplementation(async (_b: string, k: string) => customers[k] as never);

        const billing = await registry.billingByAccount('bucket');

        expect(billing['dedicated'].isDedicated).toBe(true);
        expect(billing['dedicated'].dedicatedTo).toBe('cus_harbor');
        expect(billing['shared'].isDedicated).toBe(false);
        expect(billing['shared'].tenants).toEqual(['cus_harbor', 'cus_lattice']);
        expect(billing['orphan'].tenants).toEqual([]);
        expect(billing['orphan'].isDedicated).toBe(false);
    });

    it('demotes a "dedicated" account claimed by more than one customer to shared', async () => {
        const registry = Object.assign(new MeteringRegistry(), {
            businessID: 'biz',
            customerRecordPrefix: 'onboarding/customers/',
            accounts: [{ accountId: 'contested', roleArn: '', region: 'us-east-1' }],
        });
        const customers: Record<string, unknown> = {
            'a.json': { customerId: 'cus_a', accounts: [{ accountId: 'contested', dedicated: true }] },
            'b.json': { customerId: 'cus_b', accounts: [{ accountId: 'contested' }] },
        };
        jest.spyOn(s3, 'listDocumentKeys').mockResolvedValue(Object.keys(customers));
        jest.spyOn(s3, 'getDocument').mockImplementation(async (_b: string, k: string) => customers[k] as never);

        const billing = await registry.billingByAccount('bucket');
        expect(billing['contested'].isDedicated).toBe(false);
        expect(billing['contested'].tenants).toEqual(['cus_a', 'cus_b']);
    });
});

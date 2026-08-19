import { MeteringRegistry, CustomerOnboarding } from './meteringAccounts.entity.js';

function mkRegistry(customers: any[], accounts: any[] = []): MeteringRegistry {
    const r = Object.assign(new MeteringRegistry(), {
        businessID: 'b',
        customerRecordPrefix: 'p/',
        accounts,
    });
    r.customers = customers.map((c) => Object.assign(new CustomerOnboarding(), c));
    return r;
}

describe('MeteringRegistry ownership helpers', () => {
    it('resolves a dedicated account with a single claimant', () => {
        const r = mkRegistry([
            { customerId: 'a', accounts: [{ accountId: '11', dedicated: true }] },
            { customerId: 'b', accounts: [{ accountId: '22' }] },
        ]);
        expect(r.dedicatedCustomer('11')?.customerId).toBe('a');
        expect(r.dedicatedCustomer('22')).toBeUndefined();
    });

    it('treats conflicting dedicated claims as not dedicated (shared)', () => {
        const r = mkRegistry([
            { customerId: 'a', accounts: [{ accountId: '11', dedicated: true }] },
            { customerId: 'b', accounts: [{ accountId: '11', dedicated: true }] },
        ]);
        expect(r.dedicatedCustomer('11')).toBeUndefined();
        expect(
            r
                .onboardedCustomers('11')
                .map((c) => c.customerId)
                .sort(),
        ).toEqual(['a', 'b']);
    });

    it('lists onboarded customers per account', () => {
        const r = mkRegistry([
            { customerId: 'a', accounts: [{ accountId: '11' }, { accountId: '22' }] },
            { customerId: 'b', accounts: [{ accountId: '22' }] },
        ]);
        expect(
            r
                .onboardedCustomers('22')
                .map((c) => c.customerId)
                .sort(),
        ).toEqual(['a', 'b']);
        expect(r.onboardedCustomers('11').map((c) => c.customerId)).toEqual(['a']);
        expect(r.onboardedCustomers('99')).toEqual([]);
    });

    it('tolerates customers with no accounts array', () => {
        const r = mkRegistry([{ customerId: 'a' }]);
        expect(r.onboardedCustomers('11')).toEqual([]);
        expect(r.dedicatedCustomer('11')).toBeUndefined();
    });
});

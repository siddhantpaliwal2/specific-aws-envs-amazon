import { Ec2InstanceDataGathererService, MeteredInstance } from './ec2InstanceDataGatherer.service.js';
import { CustomerRecord } from '../../onboarding/entities/meteringAccounts.entity.js';

const INCREMENT = 0.08333333;

describe('Ec2InstanceDataGathererService allocation rules', () => {
    const customerRecords: Array<CustomerRecord> = [
        {
            customerId: 'cus_harbor',
            displayName: 'Harbor Analytics',
            accounts: [{ accountId: '100000000011', dedicated: true }, { accountId: '100000000022' }],
        },
        {
            customerId: 'cus_lattice',
            displayName: 'Lattice Robotics',
            accounts: [{ accountId: '100000000022' }],
        },
    ];

    const mk = (accountId: string, instanceId: string, tags: Record<string, string>): MeteredInstance => ({
        accountId,
        instanceId,
        instanceType: 'm5.large',
        region: 'us-east-1',
        tags,
    });

    it('classifies accounts from onboarding records', () => {
        const alloc = Ec2InstanceDataGathererService.buildAccountAllocations(customerRecords);
        expect(alloc['100000000011']).toEqual({ kind: 'dedicated', customerId: 'cus_harbor' });
        expect(alloc['100000000022']).toEqual({ kind: 'shared', customerIds: ['cus_harbor', 'cus_lattice'] });
    });

    it('dedicated account: all machines go to the dedicated customer regardless of tags', () => {
        const instances = [
            mk('100000000011', 'i-1', { meteringCustomerId: 'cus_harbor' }),
            mk('100000000011', 'i-2', {}), // no tag
            mk('100000000011', 'i-3', { meteringCustomerId: 'cus_lattice' }), // wrong tag
        ];
        const alloc = Ec2InstanceDataGathererService.buildAccountAllocations(customerRecords);
        const out = Ec2InstanceDataGathererService.allocateUsage({
            instances,
            allocationByAccount: alloc,
            businessID: 'biz',
            dimensionId: 'dim',
        });
        expect(out).toHaveLength(1);
        expect(out[0].customerId).toBe('cus_harbor');
        expect(out[0].recordValue).toBeCloseTo(3 * INCREMENT, 6);
        expect(out[0].metadata.instanceCount).toBe(3);
    });

    it('shared account: each machine split evenly among onboarded tenants', () => {
        const instances = [
            mk('100000000022', 'i-11', { meteringCustomerId: 'cus_harbor,cus_lattice' }),
            mk('100000000022', 'i-12', {}),
            mk('100000000022', 'i-13', { meteringCustomerId: 'cus_lattice' }),
        ];
        const alloc = Ec2InstanceDataGathererService.buildAccountAllocations(customerRecords);
        const out = Ec2InstanceDataGathererService.allocateUsage({
            instances,
            allocationByAccount: alloc,
            businessID: 'biz',
            dimensionId: 'dim',
        });
        const byCustomer = Object.fromEntries(out.map((o) => [o.customerId, o]));
        expect(byCustomer['cus_harbor'].recordValue).toBeCloseTo(3 * (INCREMENT / 2), 6);
        expect(byCustomer['cus_lattice'].recordValue).toBeCloseTo(3 * (INCREMENT / 2), 6);
    });

    it('combined: harbor gets dedicated + shared share, lattice gets shared share', () => {
        const instances = [
            mk('100000000011', 'i-1', { meteringCustomerId: 'cus_harbor' }),
            mk('100000000011', 'i-2', {}),
            mk('100000000011', 'i-3', { meteringCustomerId: 'cus_lattice' }),
            mk('100000000022', 'i-11', { meteringCustomerId: 'cus_harbor,cus_lattice' }),
            mk('100000000022', 'i-12', {}),
            mk('100000000022', 'i-13', { meteringCustomerId: 'cus_lattice' }),
        ];
        const alloc = Ec2InstanceDataGathererService.buildAccountAllocations(customerRecords);
        const out = Ec2InstanceDataGathererService.allocateUsage({
            instances,
            allocationByAccount: alloc,
            businessID: 'biz',
            dimensionId: 'dim',
        });
        const byCustomer = Object.fromEntries(out.map((o) => [o.customerId, o]));
        expect(byCustomer['cus_harbor'].recordValue).toBeCloseTo(3 * INCREMENT + 3 * (INCREMENT / 2), 6);
        expect(byCustomer['cus_lattice'].recordValue).toBeCloseTo(3 * (INCREMENT / 2), 6);
    });

    it('unplaceable: account with no onboarded customer is billed to nobody', () => {
        const instances = [mk('999999999999', 'i-x', { meteringCustomerId: 'cus_harbor' })];
        const alloc = Ec2InstanceDataGathererService.buildAccountAllocations(customerRecords);
        const out = Ec2InstanceDataGathererService.allocateUsage({
            instances,
            allocationByAccount: alloc,
            businessID: 'biz',
            dimensionId: 'dim',
        });
        expect(out).toHaveLength(0);
    });
});

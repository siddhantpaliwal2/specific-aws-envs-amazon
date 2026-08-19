import { Ec2InstanceDataGathererService } from './ec2InstanceDataGatherer.service.js';
import { MeteredAccount } from '../../onboarding/entities/meteringAccounts.entity.js';

const RUNNING_TIME_INCREMENT = 0.08333333;

describe('Ec2InstanceDataGathererService billing rules (emulator registry)', () => {
    const registryBucket = 'metering-metering-cadence';
    const registryKey = 'onboarding/registry.json';
    const dimensionId = 'dim-uptime';

    const mkInstance = (accountId: string, instanceId: string, tags: Record<string, string> = {}) => ({
        accountId,
        instanceId,
        instanceType: 't3.micro',
        region: 'us-east-1',
        tags: { meteringDimensionId: dimensionId, ...tags },
    });

    const mockReadAccount = (byAccount: Record<string, any[]>) =>
        jest.spyOn(Ec2InstanceDataGathererService as any, 'readAccount').mockImplementation(async (...args: any[]) => {
            const account = args[0] as MeteredAccount;
            return byAccount[account.accountId] ?? [];
        });

    afterEach(() => jest.restoreAllMocks());

    it('bills all dedicated-account uptime to the dedicated customer regardless of tags', async () => {
        // account 11 dedicated to cus_harbor; account 22 shared harbor+lattice
        mockReadAccount({
            '100000000011': [
                mkInstance('100000000011', 'i-ded-a', { meteringCustomerId: '' }),
                mkInstance('100000000011', 'i-ded-b', { meteringCustomerId: 'cus_someoneelse' }),
                mkInstance('100000000011', 'i-ded-c'),
            ],
            '100000000022': [],
        });
        const svc = new Ec2InstanceDataGathererService();
        const out = await svc.gatherUsage({ businessID: 'biz-cadence', dimensionId, registryBucket, registryKey });
        const harbor = out.find((m) => m.customerId === 'cus_harbor');
        expect(harbor).toBeDefined();
        expect(harbor.recordValue).toBeCloseTo(3 * RUNNING_TIME_INCREMENT);
        // no bogus customer billed
        expect(out.find((m) => m.customerId === 'cus_someoneelse')).toBeUndefined();
    });

    it('divides shared-account uptime evenly among genuinely onboarded tenants', async () => {
        mockReadAccount({
            '100000000011': [],
            '100000000022': [
                mkInstance('100000000022', 'i-shared-1', { meteringCustomerId: 'cus_harbor' }),
                mkInstance('100000000022', 'i-shared-2'),
            ],
        });
        const svc = new Ec2InstanceDataGathererService();
        const out = await svc.gatherUsage({ businessID: 'biz-cadence', dimensionId, registryBucket, registryKey });
        const harbor = out.find((m) => m.customerId === 'cus_harbor');
        const lattice = out.find((m) => m.customerId === 'cus_lattice');
        // 2 instances split evenly between the 2 tenants -> each gets 1 instance-worth
        expect(harbor.recordValue).toBeCloseTo(2 * (RUNNING_TIME_INCREMENT / 2));
        expect(lattice.recordValue).toBeCloseTo(2 * (RUNNING_TIME_INCREMENT / 2));
    });

    it('keeps unplaceable usage (account with no onboarded customer) off the bill', async () => {
        // Pretend an extra account with no onboarding record shows up.
        const svc = new Ec2InstanceDataGathererService();
        jest.spyOn(Ec2InstanceDataGathererService as any, 'readAccount').mockImplementation(async (...args: any[]) => {
            const account = args[0] as MeteredAccount;
            if (account.accountId === '100000000022') {
                return [mkInstance('100000000022', 'i-x', { meteringCustomerId: 'nobody' })];
            }
            return [];
        });
        const out = await svc.gatherUsage({ businessID: 'biz-cadence', dimensionId, registryBucket, registryKey });
        // account 22 is shared between harbor+lattice -> both billed evenly, nobody-tag ignored
        expect(out.map((m) => m.customerId).sort()).toEqual(['cus_harbor', 'cus_lattice']);
        expect(out.find((m) => m.customerId === 'nobody')).toBeUndefined();
    });
});

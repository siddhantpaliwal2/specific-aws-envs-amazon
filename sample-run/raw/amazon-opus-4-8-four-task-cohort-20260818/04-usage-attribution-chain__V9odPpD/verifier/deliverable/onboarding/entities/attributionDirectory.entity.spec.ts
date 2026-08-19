import { AttributionDirectory } from './attributionDirectory.entity.js';

jest.mock('../../utils/aws/s3.js', () => ({
    getDocument: jest.fn(),
}));
// eslint-disable-next-line import/first
import { getDocument } from '../../utils/aws/s3.js';

const pools = {
    aurora: { chargeCode: 'cc-a' }, // terminal
    dovetail: { chargeCode: 'cc-d', rollsUpTo: 'unit/ember' }, // -> ember terminal
    harrow: { chargeCode: 'cc-h', rollsUpTo: 'node/x/y/z' }, // unresolvable -> stays cc-h
    // cycle: loopA -> unit/loopU -> pool/loopA, both share cc-loop
    loopA: { chargeCode: 'cc-loop', rollsUpTo: 'unit/loopU' },
};
const units = {
    ember: { unitId: 'bu-ember', chargeCode: 'cc-e' },
    loopU: { unitId: 'bu-loopU', chargeCode: 'cc-loop', parentRef: 'pool/loopA' },
};

describe('AttributionDirectory.finalChargeCodeFor', () => {
    beforeEach(() => {
        (getDocument as jest.Mock).mockImplementation(async (_b: string, key: string) => {
            if (key.endsWith('pools.json')) return { revision: '1', pools };
            const m = key.match(/units\/(.+)\.json$/);
            if (m && units[m[1]]) return units[m[1]];
            const err: any = new Error('NoSuchKey');
            err.name = 'NoSuchKey';
            throw err;
        });
    });

    it('resolves terminal, chain, unresolvable, and cycle', async () => {
        const d = await AttributionDirectory.load('b', 'attribution/');
        expect(await d.finalChargeCodeFor('pool/aurora')).toBe('cc-a');
        expect(await d.finalChargeCodeFor('pool/dovetail')).toBe('cc-e');
        expect(await d.finalChargeCodeFor('pool/harrow')).toBe('cc-h');
        expect(await d.finalChargeCodeFor('pool/loopA')).toBe('cc-loop');
        expect(await d.finalChargeCodeFor('unit/loopU')).toBe('cc-loop');
        expect(await d.finalChargeCodeFor('pool/missing')).toBeUndefined();
        expect(await d.finalChargeCodeFor('')).toBeUndefined();
    });
});

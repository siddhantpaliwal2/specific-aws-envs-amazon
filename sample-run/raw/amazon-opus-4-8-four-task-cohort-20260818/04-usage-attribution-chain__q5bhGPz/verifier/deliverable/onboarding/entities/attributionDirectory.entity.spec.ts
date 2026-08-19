import { AttributionDirectory } from './attributionDirectory.entity.js';
import * as s3 from '../../utils/aws/s3.js';

jest.mock('../../utils/aws/s3.js');

const mockedGetDocument = s3.getDocument as jest.Mock;
const mockedListKeys = s3.listDocumentKeys as jest.Mock;

const bucket = 'metering';
const prefix = 'attribution/';

const buildDirectory = (
    pools: Record<string, { chargeCode: string; rollsUpTo?: string }>,
    units: Record<string, { chargeCode: string; parentRef?: string }> = {},
) => {
    mockedListKeys.mockResolvedValue(Object.keys(units).map((name) => `${prefix}units/${name}.json`));
    mockedGetDocument.mockImplementation(async (_b: string, key: string) => {
        if (key === `${prefix}pools.json`) {
            return { revision: 'r', pools };
        }
        const match = key.match(/units\/(.+)\.json$/);
        if (match) {
            const unit = units[match[1]];
            return unit ? { unitId: `bu-${match[1]}`, ...unit } : undefined;
        }
        return undefined;
    });
    return AttributionDirectory.load(bucket, prefix);
};

describe('AttributionDirectory.chargeCodeFor', () => {
    afterEach(() => jest.clearAllMocks());

    it('books a line that carries its own cost to its own code', async () => {
        const directory = await buildDirectory({ aurora: { chargeCode: 'cc-core' } });
        expect(directory.chargeCodeFor('pool/aurora')).toBe('cc-core');
    });

    it('follows a chain to the final code rather than an intermediate one', async () => {
        const directory = await buildDirectory(
            { dovetail: { chargeCode: 'cc-queue', rollsUpTo: 'unit/ember' } },
            { ember: { chargeCode: 'cc-ml-training' } },
        );
        expect(directory.chargeCodeFor('pool/dovetail')).toBe('cc-ml-training');
    });

    it('follows a multi hop chain across pools and units', async () => {
        const directory = await buildDirectory(
            {
                fathom: { chargeCode: 'cc-asset', rollsUpTo: 'unit/girder' },
            },
            {
                girder: { chargeCode: 'cc-mid', parentRef: 'unit/final' },
                final: { chargeCode: 'cc-final' },
            },
        );
        expect(directory.chargeCodeFor('pool/fathom')).toBe('cc-final');
    });

    it('stops at the last held node when the chain hands off to unheld material', async () => {
        const directory = await buildDirectory({
            harrow: { chargeCode: 'cc-session', rollsUpTo: 'node/acct/region/i-123' },
        });
        expect(directory.chargeCodeFor('pool/harrow')).toBe('cc-session');
    });

    it('uses the charge code shared by a cycle', async () => {
        const directory = await buildDirectory(
            { mossgate: { chargeCode: 'cc-batch', rollsUpTo: 'unit/northgate' } },
            { northgate: { chargeCode: 'cc-batch', parentRef: 'pool/mossgate' } },
        );
        expect(directory.chargeCodeFor('pool/mossgate')).toBe('cc-batch');
    });

    it('drops a line whose starting reference is not held', async () => {
        const directory = await buildDirectory({ aurora: { chargeCode: 'cc-core' } });
        expect(directory.chargeCodeFor('pool/unknown')).toBeUndefined();
        expect(directory.chargeCodeFor('alias/whatever')).toBeUndefined();
    });
});

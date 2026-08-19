import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

export const putDocument = (document, Bucket, Key) =>
    new Upload({ client: new S3Client({ region: 'us-east-1' }), params: { Body: document, Bucket, Key } });

export const getDocument = async <T>(Bucket: string, Key: string, credentials = undefined): Promise<T> => {
    const client = new S3Client(credentials ? { credentials } : {});
    const { Body } = await client.send(new GetObjectCommand({ Bucket, Key }));
    return JSON.parse(await Body.transformToString()) as T;
};

export const listDocumentKeys = async (
    Bucket: string,
    Prefix: string,
    credentials = undefined,
): Promise<Array<string>> => {
    const client = new S3Client(credentials ? { credentials } : {});
    const keys: Array<string> = [];
    let ContinuationToken: string;
    do {
        // Need to do this for pagination
        // eslint-disable-next-line no-await-in-loop
        const response = await client.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken }));
        ContinuationToken = response?.NextContinuationToken;
        (response?.Contents ?? []).forEach(({ Key }) => {
            if (Key && !Key.endsWith('/')) {
                keys.push(Key);
            }
        });
    } while (ContinuationToken);
    return keys;
};

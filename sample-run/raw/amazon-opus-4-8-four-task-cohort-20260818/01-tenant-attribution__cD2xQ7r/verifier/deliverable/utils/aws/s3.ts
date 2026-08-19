import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

export const putDocument = (document, Bucket, Key) =>
    new Upload({ client: new S3Client({ region: 'us-east-1' }), params: { Body: document, Bucket, Key } });

export const getDocument = async <T>(Bucket: string, Key: string): Promise<T> => {
    const client = new S3Client({});
    const { Body } = await client.send(new GetObjectCommand({ Bucket, Key }));
    return JSON.parse(await Body.transformToString()) as T;
};

/**
 * Lists the keys of every object stored under a prefix, following pagination.
 * Prefix "directory placeholder" keys (those ending in "/") are skipped.
 */
export const listDocuments = async (Bucket: string, Prefix: string): Promise<Array<string>> => {
    const client = new S3Client({});
    const keys: Array<string> = [];
    let ContinuationToken: string | undefined;
    do {
        const response = await client.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken }));
        (response.Contents ?? []).forEach(({ Key }) => {
            if (Key && !Key.endsWith('/')) {
                keys.push(Key);
            }
        });
        ContinuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (ContinuationToken);
    return keys;
};

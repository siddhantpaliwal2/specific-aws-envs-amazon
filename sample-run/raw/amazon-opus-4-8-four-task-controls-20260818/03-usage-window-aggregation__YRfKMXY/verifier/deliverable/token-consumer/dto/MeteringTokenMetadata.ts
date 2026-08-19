import { TokenType } from './TokenType';

export type MeteringTokenMetadata = {
    [key: string]: string;
    tokenType: TokenType;
};

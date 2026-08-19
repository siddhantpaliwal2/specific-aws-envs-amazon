import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class UsageAttributionDto {
    /**
     *
     * Static string indicating the dimensionType
     */
    @IsString()
    @IsNotEmpty()
    public dimensionType: 'attributedSpend';

    @IsOptional()
    public dimensionId?: string;

    /**
     * The metering bucket holding the business' onboarding record.
     */
    @IsString()
    @IsNotEmpty()
    public registryBucket: string;

    /**
     * The key of the onboarding record inside that bucket.
     */
    @IsString()
    @IsNotEmpty()
    public registryKey: string;
}

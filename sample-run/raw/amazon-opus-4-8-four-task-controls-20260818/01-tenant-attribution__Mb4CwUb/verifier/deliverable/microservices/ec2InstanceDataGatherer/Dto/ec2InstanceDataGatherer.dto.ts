import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { infrastructureType } from '../../../dimensions/dto/create-dimension.dto.js';

export class Ec2InstanceDataGathererDto {
    /**
     *
     * Static string indicating the dimensionType
     */
    @IsString()
    @IsNotEmpty()
    public dimensionType: infrastructureType.instanceRunningTime;

    @IsOptional()
    public dimensionId?: string;

    /**
     * The metering bucket holding the business' onboarding records.
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

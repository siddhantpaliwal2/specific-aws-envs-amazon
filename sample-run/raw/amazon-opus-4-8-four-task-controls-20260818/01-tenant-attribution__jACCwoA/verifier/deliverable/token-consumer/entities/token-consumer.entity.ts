import { MeasurementFormat } from '../../measurement-config/entities/measurement.interface';
import { StandardMeasurementEntity } from '../../measurement-config/entities/standardMeasurement.entity';
import { UsageEntity } from '../../usage/entities/usage.entity';
import { MeteringToken } from '../dto/meteringToken.dto';
import { MeteringTokenMetadata } from 'token-consumer/dto/MeteringTokenMetadata';

export class TokenConsumer {
    public static _measurement = 'tokenConsumer';
    public static meteringDogFoodProductionBusinessID = 'metering-production';
    public static meteringDogFoodSandboxBusinessID = 'metering-sandbox';
    public static productionDimensionId = '697f07d0-3180-4351-bdff-7ca029e6c18d';
    public static sandboxDimensionId = '00abdf4f-f975-41c6-8293-76ba09a5cb23';
    saasCustomerBusinessID: string;
    customerId: string;
    saasCustomerAssociatedBusinessID: string;
    tokenAmount: string;
    timestamp: string;
    metadata?: MeteringTokenMetadata;

    constructor(meteringToken: MeteringToken, customerId: string, saasCustomerAssociatedBusinessID: string) {
        if (meteringToken) {
            this.saasCustomerBusinessID = meteringToken.businessID;
            this.tokenAmount = meteringToken.tokenAmount;

            if (meteringToken.metadata) {
                this.metadata = meteringToken.metadata;
            }
            this.timestamp = meteringToken.timestamp;
            this.saasCustomerAssociatedBusinessID = saasCustomerAssociatedBusinessID;
            this.customerId = customerId;
        }
    }
    static tokenConsumerToStandardMeasurementEntity(tokenConsumer: TokenConsumer): MeasurementFormat {
        return {
            businessID:
                tokenConsumer?.saasCustomerAssociatedBusinessID === TokenConsumer.meteringDogFoodProductionBusinessID
                    ? TokenConsumer.meteringDogFoodProductionBusinessID
                    : TokenConsumer.meteringDogFoodSandboxBusinessID,
            customerId: tokenConsumer.customerId,
            recordValue: parseFloat(tokenConsumer.tokenAmount),
            timestamp: tokenConsumer.timestamp,
            metadata: tokenConsumer.metadata,
            _measurement: TokenConsumer._measurement,
            dimensionId:
                tokenConsumer?.saasCustomerAssociatedBusinessID === TokenConsumer.meteringDogFoodProductionBusinessID
                    ? TokenConsumer.productionDimensionId
                    : TokenConsumer.sandboxDimensionId,
        };
    }
    static publish(tokenConsumer: TokenConsumer) {
        const { tokenAmount, metadata, customerId, timestamp } = tokenConsumer;
        const entity = new StandardMeasurementEntity({
            timestamp,
            recordValue: parseFloat(tokenAmount),
            _measurement: UsageEntity._measurement,
            businessID:
                tokenConsumer?.saasCustomerAssociatedBusinessID === TokenConsumer.meteringDogFoodProductionBusinessID
                    ? TokenConsumer.meteringDogFoodProductionBusinessID
                    : TokenConsumer.meteringDogFoodSandboxBusinessID,
            customerId,
            metadata: metadata,
            dimensionId:
                tokenConsumer?.saasCustomerAssociatedBusinessID === TokenConsumer.meteringDogFoodProductionBusinessID
                    ? TokenConsumer.productionDimensionId
                    : TokenConsumer.sandboxDimensionId,
        });
        StandardMeasurementEntity.publish(entity);
    }
}

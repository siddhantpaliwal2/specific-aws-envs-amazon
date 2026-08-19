import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class FindPaymentsQueryParamDto {
    /**
     * The Metering invoiceId associated with the stripe payment. Can be undefined.
     * This operation instructs metering to search for payments with the given invoiceId in the metadata of the payment intent.
     * <br><br>
     * Example: `"476b84a0-bba7-4e05-9040-59cffdff493a"`
     * @example "476b84a0-bba7-4e05-9040-59cffdff493a"
     */
    @IsOptional()
    @IsString()
    @ApiProperty({
        externalDocs: {
            url: 'https://docs.product.example/invoice-and-process-payment/issue-invoice',
            description: 'Metering API Reference: Issue Invoice',
        },
    })
    invoiceId?: string;
}

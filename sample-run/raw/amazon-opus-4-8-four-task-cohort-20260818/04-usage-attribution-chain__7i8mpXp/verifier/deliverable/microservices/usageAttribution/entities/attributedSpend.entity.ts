import { Point } from '@influxdata/influxdb-client';
import { InfluxService } from '../../../influx/influx.service.js';

/**
 * What one charge code ended up carrying once every metered line the business
 * exported had been attributed.
 */
export class AttributedSpendEntity {
    public static _measurement = 'AttributedSpendData';

    public businessID: string;
    /**
     * The code the spend is booked to.
     * @example "cc-platform-core"
     */
    public chargeCode: string;
    /** How much of the metered dimension sits under the code. */
    public quantity: number;
    /** What that came to in the reporting currency. */
    public amount: number;
    /** How many exported lines make up the two figures above. */
    public lineCount: number;

    constructor({ businessID, chargeCode, quantity, amount, lineCount }: AttributedSpendEntity) {
        this.businessID = businessID;
        this.chargeCode = chargeCode;
        this.quantity = quantity;
        this.amount = amount;
        this.lineCount = lineCount;
    }

    public static transformer(entity: AttributedSpendEntity, influxService: InfluxService): Point {
        const { businessID, chargeCode, quantity, amount, lineCount } = entity;

        const point = influxService.getPoint(AttributedSpendEntity._measurement);
        point.tag('businessID', businessID);
        point.tag('chargeCode', chargeCode);
        point.floatField('quantity', quantity);
        point.floatField('amount', amount);
        point.intField('lineCount', lineCount);

        return point;
    }

    public static dbModelToEntity(dbModel: any): AttributedSpendEntity {
        const { businessID, chargeCode, _value, amount, lineCount } = dbModel;

        return new AttributedSpendEntity({
            businessID,
            chargeCode,
            quantity: _value,
            amount,
            lineCount,
        });
    }
}

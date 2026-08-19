import { MeteringTokenMetadata } from './MeteringTokenMetadata';

export class MeteringToken {
    businessID: string;
    tokenAmount: string;
    subject?: string;
    metadata?: MeteringTokenMetadata;
    timestamp?: string;
    constructor(meteringToken: MeteringToken) {
        if (meteringToken) {
            this.businessID = meteringToken.businessID;
            this.tokenAmount = meteringToken.tokenAmount;
            if (meteringToken.metadata) {
                this.metadata = meteringToken.metadata;
            }
            if (meteringToken.subject) {
                this.subject = meteringToken.subject;
            }
            if (meteringToken.timestamp) {
                this.timestamp = meteringToken.timestamp;
            } else {
                this.timestamp = new Date().toISOString();
            }
        }
    }
}

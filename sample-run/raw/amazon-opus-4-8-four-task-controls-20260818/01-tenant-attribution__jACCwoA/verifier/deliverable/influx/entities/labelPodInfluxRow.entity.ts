import { BaseInfluxTable } from './baseInfluxTable.entity.js';

export class LabelPodInfluxRow extends BaseInfluxTable {
    public declare _measurement: 'metering_kube_pod_labels';
    public businessID: string;
    public label_metering_dimension_id: string;
    public label_metering_customer_id: string;
    public pod: string;
}

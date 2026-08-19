import { BaseInfluxTable } from './baseInfluxTable.entity.js';

export class MeteringContainerCpuUsageSecondsTotal extends BaseInfluxTable {
    /**
     *
     * The unique Id for a pod
     * @example "ebs-csi-node-xs8cb"
     * @example "metering-agent"
     */
    public pod: string;

    public declare _value: number;
}

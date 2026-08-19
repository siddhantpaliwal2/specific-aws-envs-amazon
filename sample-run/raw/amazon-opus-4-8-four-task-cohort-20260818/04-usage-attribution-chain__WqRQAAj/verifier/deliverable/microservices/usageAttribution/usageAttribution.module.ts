import { Module, forwardRef } from '@nestjs/common';
import { InfluxModule } from '../../influx/influx.module.js';
import { UsageAttributionService } from './usageAttribution.service.js';
import { BullModule } from '@nestjs/bull';

@Module({
    controllers: [],
    providers: [UsageAttributionService],
    imports: [
        forwardRef(() => InfluxModule),
        BullModule.registerQueue({
            name: 'scheduler_queue',
        }),
    ],
})
export class UsageAttributionModule {}

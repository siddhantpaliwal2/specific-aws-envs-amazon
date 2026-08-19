import { BadRequestException, Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { MeteringToken } from './dto/meteringToken.dto';
import { InfluxService } from '../influx/influx.service';
import { UserEntitlements } from '../users/entities/entitlement.entity';
import { cache as cacheManager } from '../cacheStore.js';
import { TokenConsumer } from './entities/token-consumer.entity';
import { BasicResponseDTO } from '../basicResponseDTO';
import { AuditService } from '../audit/audit.service';
import { AuditScope } from '../audit/entities/audit.interface';
import { serializeError } from 'serialize-error';
import { SchedulerService } from '../scheduler/scheduler.service';
import { SchedulerStatus, SupportedMeasurementFrequencies, schedulerType } from '../scheduler/dto/scheduler.dto';
import { TokenConsumerAsyncProcessor } from './token-consumer-async-processor';
import { ReadCustomerResponseData } from '../customer/entities/customer.entity';
import { LocalJWTAuthService } from '../authz/jwt-local.strategy';
import { TokenAsyncAggregatorDto } from './dto/schedulerAsyncProcessor.dto';
import { MeasurementFormat } from '../measurement-config/entities/measurement.interface';
import { Point } from '@influxdata/influxdb-client';
import { EnvironmentService } from '../users/users.service';

@Injectable()
export class TokenConsumerService {
    public static cacheKey = (businessID) => `${businessID}-tokenConsumer`;
    public static logger = new Logger(TokenConsumerService.name);
    constructor(
        @Inject(forwardRef(() => SchedulerService)) readonly schedulerService: SchedulerService,
        @Inject(forwardRef(() => LocalJWTAuthService)) readonly localJWTAuthService: LocalJWTAuthService,
        @Inject(forwardRef(() => InfluxService)) readonly influxService: InfluxService,
        @Inject(forwardRef(() => EnvironmentService)) readonly environmentSerivce: EnvironmentService,
    ) {}
    async create(meteringToken: MeteringToken): Promise<BasicResponseDTO> {
        try {
            TokenConsumerService.logger.debug(
                `Metering Token for businessID: ${meteringToken?.businessID}, purpose: ${meteringToken?.metadata?.tokenType}`,
            );
            const res = await TokenConsumerService.getMeteringCustomerId(
                meteringToken.businessID,
                meteringToken?.subject,
                this.environmentSerivce,
            );
            if (res) {
                const { meteringCustomerId, saasCustomerAssociatedBusinessID } = res;
                const tokenConsumer = new TokenConsumer(meteringToken, meteringCustomerId, saasCustomerAssociatedBusinessID);
                TokenConsumerService.logger.debug(`Metering Token for metering customerId: ${meteringCustomerId}`);
                TokenConsumer.publish(tokenConsumer);
                return { message: `Token Consumer created for businessID: ${meteringToken?.businessID}` };
            } else {
                TokenConsumerService.logger.error(`No customer found for businessID: ${meteringToken?.businessID}`);
                throw new BadRequestException(`No customer found for businessID: ${meteringToken?.businessID}`);
            }
        } catch (e) {
            TokenConsumerService.logger.error('Failed to create Token Consumer', serializeError(e));
            AuditService.publishEvent({
                topic: AuditScope.ERROR,
                message: 'Failed to create Token Consumer',
                data: [serializeError(e)],
            });
        }
    }
    async queueToken(meteringToken: MeteringToken) {
        try {
            const res = await TokenConsumerService.getMeteringCustomerId(
                meteringToken.businessID,
                meteringToken?.subject,
                this.environmentSerivce,
            );
            if (res) {
                const { meteringCustomerId, saasCustomerAssociatedBusinessID } = res;
                const measurementFormat: MeasurementFormat = TokenConsumer.tokenConsumerToStandardMeasurementEntity(
                    new TokenConsumer(meteringToken, meteringCustomerId, saasCustomerAssociatedBusinessID),
                );
                const point = MeasurementFormat.getPointForm(
                    measurementFormat,
                    null,
                    new Point(TokenConsumer._measurement),
                );
                TokenConsumerService.logger.debug(`TokenRegisterInterceptor loading point`);
                await this.influxService.loadPoints(
                    TokenConsumerAsyncProcessor.tokenAggregateBucket,
                    process.env.INFLUX_ORG,
                    [point],
                    false,
                );
            }
        } catch (e) {
            TokenConsumerService.logger.error('Failed to queue token', serializeError(e));
            AuditService.publishEvent({
                topic: AuditScope.ERROR,
                message: 'Failed to queue token',
                data: [serializeError(e)],
            });
        }
    }
    public static async getMeteringCustomerId(
        businessID: string,
        subject?: string,
        environmentSerivce?: EnvironmentService,
    ): Promise<{
        meteringCustomerId: string;
        saasCustomerAssociatedBusinessID: string;
        meteringCustomer: ReadCustomerResponseData;
    } | void> {
        const jsonBlob: string = await cacheManager.get(TokenConsumerService.cacheKey(businessID));
        let meteringCustomerId: string;
        let saasCustomerAssociatedBusinessID: string;
        let meteringCustomer: ReadCustomerResponseData;
        if (!jsonBlob) {
            let businessIDs: string[] = [];
            if (subject) {
                const allEnvs = await environmentSerivce.getEnvironmentsForUser(subject);
                businessIDs = allEnvs.map((env) => env.businessID);
            } else {
                businessIDs = [businessID];
            }
            const { data } = await UserEntitlements.queryForMeteringCustomer({
                businessIDs,
            });
            if (data.length) {
                TokenConsumerService.logger.debug(
                    `Storing customer: ${data[0].customerId} for businessID: ${data[0].businessID} in token cache`,
                );
                await cacheManager.set(
                    TokenConsumerService.cacheKey(businessID),
                    JSON.stringify({
                        customerId: data[0].customerId,
                        saasCustomerAssociatedBusinessID: data[0].businessID,
                        customerRes: data[0],
                    }),
                );
            } else {
                TokenConsumerService.logger.error(`No customer found for businessID: ${businessID}`);
                return;
            }
            meteringCustomerId = data[0].customerId;
            saasCustomerAssociatedBusinessID = data[0].businessID;
            meteringCustomer = data[0];
        } else {
            const parsedJson = JSON.parse(jsonBlob);
            TokenConsumerService.logger.debug(
                `Retrieved customer: ${parsedJson.customerId} from token cache with MeteringBusinessID: ${parsedJson.saasCustomerAssociatedBusinessID}`,
            );
            meteringCustomerId = parsedJson.customerId;
            saasCustomerAssociatedBusinessID = parsedJson.saasCustomerAssociatedBusinessID;
            meteringCustomer = parsedJson.customerRes;
        }
        return { meteringCustomerId, saasCustomerAssociatedBusinessID, meteringCustomer };
    }
    async scheduleTokenProcessor({
        businessID,
        subject,
    }: {
        businessID: string;
        subject: string;
    }): Promise<BasicResponseDTO | void> {
        try {
            TokenConsumerService.logger.debug(`Scheduling token processor for businessID: ${businessID}`);
            await this.schedulerService.create({
                businessID,
                schedulerStatus: SchedulerStatus.live,
                subject,
                schedulerID: TokenConsumerAsyncProcessor.schedulerIdGenerator(businessID),
                schedulerType: schedulerType.dimensionDataGathering,
                scheduleParameters: {
                    businessID,
                    subject,
                    dimensionType: TokenConsumerAsyncProcessor.processorName,
                },
                rate: SupportedMeasurementFrequencies.monthlyAtNoon,
            });
            return { message: `Token Processor scheduled for businessID: ${businessID}` };
        } catch (e) {
            TokenConsumerService.logger.error('Failed to schedule token processor', serializeError(e));
            AuditService.publishEvent({
                topic: AuditScope.ERROR,
                message: 'Failed to schedule token processor',
                data: [serializeError(e)],
            });
        }
    }
    async scheduleTokenAggregator({ businessID, subject }: { businessID: string; subject: string }) {
        try {
            TokenConsumerService.logger.debug(`Scheduling token aggregator for businessID: ${businessID}`);
            const scheduleParameters: TokenAsyncAggregatorDto = {
                businessID,
                subject,
                dimensionType: TokenConsumerAsyncProcessor.aggregationProcessor,
            };

            await this.schedulerService.create({
                businessID,
                schedulerStatus: SchedulerStatus.live,
                subject,
                schedulerID: TokenConsumerAsyncProcessor.aggregationSchedulerIdGenerator(businessID),
                schedulerType: schedulerType.dimensionDataGathering,
                scheduleParameters,
                rate: SupportedMeasurementFrequencies.everySixHours,
            });
            return { message: `Token Aggregator scheduled for businessID: ${businessID}` };
        } catch (e) {
            TokenConsumerService.logger.error('Failed to schedule token aggregator', serializeError(e));
            AuditService.publishEvent({
                topic: AuditScope.ERROR,
                message: 'Failed to schedule token aggregator',
                data: [serializeError(e)],
            });
        }
    }
    async removeTokenProcessor({ businessID }: { businessID: string }): Promise<BasicResponseDTO | void> {
        try {
            TokenConsumerService.logger.debug(`Removing token processor for businessID: ${businessID}`);
            await this.schedulerService.remove({
                businessID,
                schedulerID: TokenConsumerAsyncProcessor.schedulerIdGenerator(businessID),
            });
            return { message: `Token Processor removed for businessID: ${businessID}` };
        } catch (e) {
            TokenConsumerService.logger.error('Failed to remove token processor', serializeError(e));
            AuditService.publishEvent({
                topic: AuditScope.ERROR,
                message: 'Failed to remove token processor',
                data: [serializeError(e)],
            });
        }
    }
    async removeTokenAggregator({ businessID }: { businessID: string }): Promise<BasicResponseDTO | void> {
        try {
            TokenConsumerService.logger.debug(`Removing token aggregator for businessID: ${businessID}`);
            await this.schedulerService.remove({
                businessID,
                schedulerID: TokenConsumerAsyncProcessor.aggregationSchedulerIdGenerator(businessID),
            });
            return { message: `Token Aggregator removed for businessID: ${businessID}` };
        } catch (e) {
            TokenConsumerService.logger.error('Failed to remove token aggregator', serializeError(e));
            AuditService.publishEvent({
                topic: AuditScope.ERROR,
                message: 'Failed to remove token aggregator',
                data: [serializeError(e)],
            });
        }
    }

    async findAll({ businessID }: { businessID: string }): Promise<{ access_token: string }> {
        try {
            const res = await TokenConsumerService.getMeteringCustomerId(businessID);
            if (res) {
                TokenConsumerService.logger.debug(`Finding metering token usage for businessID: ${businessID}`);
                const { meteringCustomerId, saasCustomerAssociatedBusinessID, meteringCustomer } = res;

                const tokenUsageRes = await this.localJWTAuthService.signIn(
                    meteringCustomerId,
                    saasCustomerAssociatedBusinessID,
                );
                TokenConsumerService.logger.debug(
                    `Found metering token usage for businessID: ${businessID}, meteringCustomerId: ${meteringCustomerId} and saasCustomerAssociatedBusinessID: ${saasCustomerAssociatedBusinessID}`,
                );
                return tokenUsageRes;
            } else {
                return { access_token: '' };
            }
        } catch (e) {
            TokenConsumerService.logger.error('Failed to find metering token usage', serializeError(e));
            AuditService.publishEvent({
                topic: AuditScope.ERROR,
                message: 'Failed to find metering token usage',
                data: [serializeError(e)],
            });
            return { access_token: '' };
        }
    }
}

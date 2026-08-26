import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Tip, TipStatus } from './entities/tip.entity';
import { Ride, RideStatus } from '../rides/entities/ride.entity';
import {
  PaymentRecord,
  PaymentStatus,
  PaymentType,
} from '../rides/entities/payment-record.entity';
import {
  DriverEarning,
  EarningSourceType,
  PayoutStatus,
} from '../rides/entities/driver-earning.entity';
import { CreateTipDto } from './dto/create-tip.dto';
import { NotificationsGateway } from '../notifications/notifications.gateway';

const DEFAULT_TIP_WINDOW_HOURS = 48;

@Injectable()
export class TipsService {
  private readonly logger = new Logger(TipsService.name);

  constructor(
    @InjectRepository(Tip) private readonly tips: Repository<Tip>,
    @InjectRepository(Ride) private readonly rides: Repository<Ride>,
    @InjectRepository(PaymentRecord)
    private readonly payments: Repository<PaymentRecord>,
    @InjectRepository(DriverEarning)
    private readonly driverEarnings: Repository<DriverEarning>,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsGateway,
  ) {}

  /**
   * Rider tips a completed ride. `driverId` is ALWAYS taken from
   * `ride.driverId` server-side — the client cannot influence who gets
   * paid. Tips go 100% to the driver (platform_fee stays zero here too).
   */
  async createTip(riderId: string, dto: CreateTipDto): Promise<Tip> {
    const ride = await this.rides.findOne({ where: { id: dto.rideId } });
    if (!ride) throw new NotFoundException('Ride not found');
    if (ride.riderId !== riderId) {
      throw new ForbiddenException('You can only tip your own rides');
    }
    if (ride.status !== RideStatus.COMPLETED || !ride.completedAt) {
      throw new ConflictException('Only completed rides can be tipped');
    }
    if (!ride.driverId) {
      throw new ConflictException('This ride has no matched driver to tip');
    }

    const windowHours =
      this.config.get<number>('TIP_WINDOW_HOURS') ?? DEFAULT_TIP_WINDOW_HOURS;
    const windowMs = windowHours * 60 * 60 * 1000;
    if (Date.now() - ride.completedAt.getTime() > windowMs) {
      throw new ConflictException(
        `Tips must be sent within ${windowHours} hours of ride completion`,
      );
    }

    // Idempotency: a retried request with the same key returns the
    // already-created tip instead of double-charging/double-paying out.
    const existingPayment = await this.payments.findOne({
      where: { idempotencyKey: dto.idempotencyKey },
    });
    if (existingPayment) {
      const existingTip = await this.tips.findOne({
        where: { paymentId: existingPayment.id },
      });
      if (existingTip) return existingTip;
    }

    // Never trust client-supplied driverId — always derive from the ride.
    const driverId = ride.driverId;
    const amount = String(dto.amount);

    // Payment + tip + earning are atomic. Cash tips settle immediately —
    // the rider handing cash to the driver *is* collection. Digital PSPs
    // stay unwired; do not mark a Telebirr/Chapa tip succeeded here.
    const tip = await this.payments.manager.transaction(async (em) => {
      const payment = await em.save(
        em.create(PaymentRecord, {
          userId: riderId,
          rideId: ride.id,
          type: PaymentType.TIP,
          amount,
          idempotencyKey: dto.idempotencyKey,
          status: PaymentStatus.CASH_COLLECTED,
          providerReference: `cash:tip:${ride.id}`,
          applicationFeeAmount: '0',
        }),
      );

      const savedTip = await em.save(
        em.create(Tip, {
          rideId: ride.id,
          riderId,
          driverId,
          amount,
          paymentId: payment.id,
          status: TipStatus.SUCCEEDED,
        }),
      );

      await em.save(
        em.create(DriverEarning, {
          driverId,
          sourceType: EarningSourceType.TIP,
          sourceId: savedTip.id,
          amount: savedTip.amount,
          payoutStatus: PayoutStatus.PAID,
        }),
      );

      return savedTip;
    });

    await this.notifications.notify(driverId, 'tip.received', {
      rideId: ride.id,
      tipId: tip.id,
      amount: tip.amount,
    });

    this.logger.log(
      `Tip ${tip.id}: ${tip.amount} from rider ${riderId} to driver ${driverId} for ride ${ride.id}`,
    );
    return tip;
  }
}

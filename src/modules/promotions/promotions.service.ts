import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import {
  Promotion,
  PromotionClaim,
  PromotionClaimStatus,
} from './entities/promotion.entity';

@Injectable()
export class PromotionsService {
  constructor(
    @InjectRepository(Promotion)
    private readonly promotionsRepository: Repository<Promotion>,
    @InjectRepository(PromotionClaim)
    private readonly claimsRepository: Repository<PromotionClaim>,
  ) {}

  async getAvailablePromotions(riderId: string) {
    const now = new Date();

    // Get all active promotions
    const promotions = await this.promotionsRepository
      .createQueryBuilder('p')
      .where('p.isActive = :isActive', { isActive: true })
      .andWhere('p.startsAt <= :now', { now })
      .andWhere('p.endsAt >= :now', { now })
      .getMany();

    // Get rider's existing claims
    const existingClaims = await this.claimsRepository.find({
      where: { riderId },
    });

    return promotions.map((promo) => {
      const claimsForPromo = existingClaims.filter(
        (c) => c.promotionId === promo.id,
      );
      const isClaimed = claimsForPromo.length > 0;
      const isUsed = claimsForPromo.some(
        (c) => c.status === PromotionClaimStatus.USED,
      );
      const usageLimitReached = claimsForPromo.length >= promo.maxUsagePerUser;

      return {
        ...promo,
        status: isClaimed ? (isUsed ? 'used' : 'claimed') : 'available',
        eligible: !usageLimitReached && !isUsed,
      };
    });
  }

  async listForAdmin() {
    const promotions = await this.promotionsRepository.find({
      order: { createdAt: 'DESC' },
      take: 100,
    });
    const counts = await this.claimsRepository
      .createQueryBuilder('claim')
      .select('claim.promotionId', 'promotionId')
      .addSelect('COUNT(claim.id)', 'usesCount')
      .groupBy('claim.promotionId')
      .getRawMany<{ promotionId: string; usesCount: string }>();
    const usesByPromotion = new Map(
      counts.map((count) => [count.promotionId, Number(count.usesCount)]),
    );
    return promotions.map((promotion) => ({
      ...promotion,
      usesCount: usesByPromotion.get(promotion.id) ?? 0,
    }));
  }

  async createForAdmin(input: {
    code: string;
    description: string;
    discountMinor: number;
    startsAt: string;
    endsAt: string;
    maxUsagePerUser?: number;
    maxTotalUsage?: number;
  }) {
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    if (endsAt < startsAt) {
      throw new ForbiddenException(
        'Promotion end time must not precede its start time',
      );
    }
    const promotion = this.promotionsRepository.create({
      code: input.code.trim().toUpperCase(),
      description: input.description.trim(),
      discountMinor: input.discountMinor,
      startsAt,
      endsAt,
      maxUsagePerUser: input.maxUsagePerUser ?? 1,
      maxTotalUsage: input.maxTotalUsage ?? null,
      isActive: true,
    });
    return this.promotionsRepository.save(promotion);
  }

  async claimPromotion(riderId: string, promotionId: string) {
    try {
      return await this.claimsRepository.manager.transaction(async (em) => {
        const promotion = await em.findOne(Promotion, {
          where: { id: promotionId },
          // Serializes campaign-wide usage limits as well as claim creation.
          lock: { mode: 'pessimistic_write' },
        });

        if (!promotion) {
          throw new NotFoundException('Promotion not found');
        }

        if (!promotion.isActive) {
          throw new ForbiddenException('Promotion is no longer active');
        }

        const now = new Date();
        if (now < promotion.startsAt || now > promotion.endsAt) {
          throw new ForbiddenException('Promotion is not currently valid');
        }

        const existingClaims = await em.find(PromotionClaim, {
          where: { riderId, promotionId },
          lock: { mode: 'pessimistic_write' },
        });

        // Idempotency: if already claimed and not used, return the active claim
        const activeClaim = existingClaims.find(
          (c) => c.status === PromotionClaimStatus.ACTIVE,
        );
        if (activeClaim) {
          return activeClaim;
        }

        if (existingClaims.length >= promotion.maxUsagePerUser) {
          throw new ConflictException('Usage limit reached for this promotion');
        }

        if (promotion.maxTotalUsage != null) {
          const totalClaims = await em.count(PromotionClaim, {
            where: { promotionId },
          });
          if (totalClaims >= promotion.maxTotalUsage) {
            throw new ConflictException(
              'Promotion usage limit has been reached',
            );
          }
        }

        const claim = em.create(PromotionClaim, {
          riderId,
          promotionId,
          status: PromotionClaimStatus.ACTIVE,
        });

        return em.save(PromotionClaim, claim);
      });
    } catch (error) {
      // The partial unique index is the authoritative duplicate-click/race
      // protection. If another request won the insert, return that active
      // claim instead of leaking a database error or creating a duplicate.
      if (
        error instanceof QueryFailedError &&
        (error.driverError as { code?: string } | undefined)?.code === '23505'
      ) {
        const activeClaim = await this.claimsRepository.findOne({
          where: {
            riderId,
            promotionId,
            status: PromotionClaimStatus.ACTIVE,
          },
        });
        if (activeClaim) return activeClaim;
      }
      throw error;
    }
  }

  async applyPromotionToRide(
    em: any,
    rideId: string,
    riderId: string,
    grossFareMinor: number,
  ) {
    const claims = await em.find(PromotionClaim, {
      where: { riderId, status: PromotionClaimStatus.ACTIVE },
      relations: ['promotion'],
      lock: { mode: 'pessimistic_write' },
    });

    const validClaim = claims.find((c) => {
      const now = new Date();
      return (
        c.promotion.isActive &&
        now >= c.promotion.startsAt &&
        now <= c.promotion.endsAt
      );
    });

    if (!validClaim) {
      return { appliedDiscountMinor: 0 };
    }

    const discount = Math.min(
      validClaim.promotion.discountMinor,
      grossFareMinor,
    );

    validClaim.status = PromotionClaimStatus.USED;
    validClaim.rideId = rideId;
    validClaim.discountAppliedMinor = discount;

    await em.save(PromotionClaim, validClaim);

    return { appliedDiscountMinor: discount };
  }

  async refundPromotion(em: any, rideId: string) {
    const claims = await em.find(PromotionClaim, {
      where: { rideId, status: PromotionClaimStatus.USED },
      lock: { mode: 'pessimistic_write' },
    });

    for (const claim of claims) {
      claim.status = PromotionClaimStatus.ACTIVE;
      claim.rideId = null;
      claim.discountAppliedMinor = null;
      await em.save(PromotionClaim, claim);
    }
  }
}

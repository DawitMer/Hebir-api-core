import { Test, TestingModule } from '@nestjs/testing';
import { PromotionsService } from './promotions.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  Promotion,
  PromotionClaim,
  PromotionClaimStatus,
} from './entities/promotion.entity';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConflictException } from '@nestjs/common';

describe('PromotionsService', () => {
  let service: PromotionsService;
  let promotionsRepo: any;
  let claimsRepo: any;
  let mockEntityManager: any;

  beforeEach(async () => {
    mockEntityManager = {
      findOne: jest.fn(),
      find: jest.fn(),
      count: jest.fn(),
      create: jest.fn().mockImplementation((target, dto) => dto),
      save: jest
        .fn()
        .mockImplementation((target, entity) => Promise.resolve(entity)),
    };

    promotionsRepo = {
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      })),
    };

    claimsRepo = {
      find: jest.fn().mockResolvedValue([]),
      manager: {
        transaction: jest.fn((cb) => cb(mockEntityManager)),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PromotionsService,
        { provide: getRepositoryToken(Promotion), useValue: promotionsRepo },
        { provide: getRepositoryToken(PromotionClaim), useValue: claimsRepo },
      ],
    }).compile();

    service = module.get<PromotionsService>(PromotionsService);
  });

  describe('claimPromotion', () => {
    const validPromo = {
      id: 'promo-1',
      isActive: true,
      startsAt: new Date(Date.now() - 10000),
      endsAt: new Date(Date.now() + 10000),
      maxUsagePerUser: 1,
    };

    it('should throw NotFoundException if promotion does not exist', async () => {
      mockEntityManager.findOne.mockResolvedValue(null);
      await expect(
        service.claimPromotion('rider-1', 'promo-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException if promotion is inactive', async () => {
      mockEntityManager.findOne.mockResolvedValue({
        ...validPromo,
        isActive: false,
      });
      await expect(
        service.claimPromotion('rider-1', 'promo-1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should return existing active claim idempotently', async () => {
      mockEntityManager.findOne.mockResolvedValue(validPromo);
      const existingClaim = {
        id: 'claim-1',
        status: PromotionClaimStatus.ACTIVE,
      };
      mockEntityManager.find.mockResolvedValue([existingClaim]);

      const result = await service.claimPromotion('rider-1', 'promo-1');
      expect(result).toEqual(existingClaim);
      expect(mockEntityManager.save).not.toHaveBeenCalled();
    });

    it('should create new claim if eligible', async () => {
      mockEntityManager.findOne.mockResolvedValue(validPromo);
      mockEntityManager.find.mockResolvedValue([]);

      const result = await service.claimPromotion('rider-1', 'promo-1');
      expect(result.status).toBe(PromotionClaimStatus.ACTIVE);
      expect(mockEntityManager.save).toHaveBeenCalled();
    });

    it('should enforce a campaign-wide usage limit', async () => {
      mockEntityManager.findOne.mockResolvedValue({
        ...validPromo,
        maxTotalUsage: 2,
      });
      mockEntityManager.find.mockResolvedValue([]);
      mockEntityManager.count.mockResolvedValue(2);

      await expect(
        service.claimPromotion('rider-1', 'promo-1'),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('applyPromotionToRide', () => {
    it('should return 0 discount if no active claims', async () => {
      mockEntityManager.find.mockResolvedValue([]);
      const result = await service.applyPromotionToRide(
        mockEntityManager,
        'ride-1',
        'rider-1',
        1000,
      );
      expect(result.appliedDiscountMinor).toBe(0);
    });

    it('should apply discount and cap at gross fare', async () => {
      const activeClaim = {
        id: 'claim-1',
        status: PromotionClaimStatus.ACTIVE,
        promotion: {
          isActive: true,
          startsAt: new Date(0),
          endsAt: new Date(2100, 1),
          discountMinor: 1500,
        },
      };
      mockEntityManager.find.mockResolvedValue([activeClaim]);

      const result = await service.applyPromotionToRide(
        mockEntityManager,
        'ride-1',
        'rider-1',
        1000,
      );

      expect(result.appliedDiscountMinor).toBe(1000); // capped at 1000
      expect((activeClaim as any).status).toBe(PromotionClaimStatus.USED);
      expect((activeClaim as any).rideId).toBe('ride-1');
      expect(mockEntityManager.save).toHaveBeenCalledWith(
        PromotionClaim,
        activeClaim,
      );
    });
  });

  describe('refundPromotion', () => {
    it('should restore claim to active status', async () => {
      const usedClaim = {
        id: 'claim-1',
        status: PromotionClaimStatus.USED,
        rideId: 'ride-1',
        discountAppliedMinor: 500,
      };
      mockEntityManager.find.mockResolvedValue([usedClaim]);

      await service.refundPromotion(mockEntityManager, 'ride-1');

      expect(usedClaim.status).toBe(PromotionClaimStatus.ACTIVE);
      expect(usedClaim.rideId).toBeNull();
      expect(usedClaim.discountAppliedMinor).toBeNull();
      expect(mockEntityManager.save).toHaveBeenCalledWith(
        PromotionClaim,
        usedClaim,
      );
    });
  });
});

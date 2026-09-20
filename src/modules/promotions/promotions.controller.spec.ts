import { Test, TestingModule } from '@nestjs/testing';
import { PromotionsController } from './promotions.controller';
import { PromotionsService } from './promotions.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';

describe('PromotionsController', () => {
  let controller: PromotionsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PromotionsController],
      providers: [
        {
          provide: PromotionsService,
          useValue: {
            getAvailablePromotions: jest.fn(),
            claimPromotion: jest.fn(),
          },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: jest.fn() })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: jest.fn() })
      .compile();

    controller = module.get<PromotionsController>(PromotionsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('uses the authenticated userId for listing and claiming promotions', async () => {
    const service = {
      getAvailablePromotions: jest.fn().mockResolvedValue([]),
      claimPromotion: jest.fn().mockResolvedValue({ id: 'claim' }),
    };
    const subject = new PromotionsController(service as never);
    // JwtStrategy returns userId, never id.
    const authenticatedUser = { userId: 'rider-123' };
    await subject.listPromotions(authenticatedUser);
    await subject.claimPromotion('promotion-123', authenticatedUser);
    expect(service.getAvailablePromotions).toHaveBeenCalledWith('rider-123');
    expect(service.claimPromotion).toHaveBeenCalledWith(
      'rider-123',
      'promotion-123',
    );
  });
});

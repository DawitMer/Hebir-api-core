import {
  Controller,
  Get,
  Post,
  Param,
  ParseUUIDPipe,
  Body,
  UseGuards,
} from '@nestjs/common';
import {
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  Max,
  MaxLength,
  Matches,
} from 'class-validator';
import { PromotionsService } from './promotions.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../auth/entities/user-account.entity';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

class CreatePromotionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(/\S/)
  code: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  @Matches(/\S/)
  description: string;

  @IsInt()
  @Min(0)
  @Max(2147483647)
  discountMinor: number;

  @IsDateString()
  startsAt: string;

  @IsDateString()
  endsAt: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2147483647)
  maxUsagePerUser?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2147483647)
  maxTotalUsage?: number;
}

@Controller('promotions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PromotionsController {
  constructor(private readonly promotionsService: PromotionsService) {}

  @Get()
  @Roles(UserRole.RIDER)
  async listPromotions(@CurrentUser() user: { userId: string }) {
    return this.promotionsService.getAvailablePromotions(user.userId);
  }

  @Post(':id/claim')
  @Roles(UserRole.RIDER)
  async claimPromotion(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { userId: string },
  ) {
    return this.promotionsService.claimPromotion(user.userId, id);
  }

  @Get('admin')
  @Roles(UserRole.ADMIN)
  async listForAdmin() {
    return this.promotionsService.listForAdmin();
  }

  @Post('admin')
  @Roles(UserRole.ADMIN)
  async createForAdmin(@Body() dto: CreatePromotionDto) {
    return this.promotionsService.createForAdmin(dto);
  }
}

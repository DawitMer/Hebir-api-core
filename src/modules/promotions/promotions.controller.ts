import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  UseGuards,
  Request,
} from '@nestjs/common';
import {
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { PromotionsService } from './promotions.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../auth/entities/user-account.entity';

class CreatePromotionDto {
  @IsString()
  @IsNotEmpty()
  code: string;

  @IsString()
  @IsNotEmpty()
  description: string;

  @IsInt()
  @Min(0)
  discountMinor: number;

  @IsDateString()
  startsAt: string;

  @IsDateString()
  endsAt: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxUsagePerUser?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxTotalUsage?: number;
}

@Controller('promotions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PromotionsController {
  constructor(private readonly promotionsService: PromotionsService) {}

  @Get()
  @Roles(UserRole.RIDER)
  async listPromotions(@Request() req: any) {
    return this.promotionsService.getAvailablePromotions(req.user.id);
  }

  @Post(':id/claim')
  @Roles(UserRole.RIDER)
  async claimPromotion(@Param('id') id: string, @Request() req: any) {
    return this.promotionsService.claimPromotion(req.user.id, id);
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

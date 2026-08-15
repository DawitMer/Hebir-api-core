import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../auth/entities/user-account.entity';
import { GovService } from './gov.service';

const ALLOWED_CATEGORIES = new Set([
  'fuel',
  'maintenance',
  'insurance',
  'tolls',
  'other',
  'Fuel',
  'Maintenance',
  'Insurance',
  'Tolls & Parking',
  'Other',
]);

class CreateExpenseDto {
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  category: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(1_000_000)
  amount: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  /** ISO date for when the expense was incurred. Defaults to now. */
  @IsOptional()
  @IsString()
  incurredAt?: string;
}

@Controller('drivers/expenses')
export class DriverExpensesController {
  constructor(private readonly govService: GovService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.DRIVER, UserRole.ADMIN)
  @Post()
  create(
    @CurrentUser() user: { userId: string },
    @Body() body: CreateExpenseDto,
  ) {
    if (!ALLOWED_CATEGORIES.has(body.category.trim())) {
      throw new BadRequestException(
        'category must be fuel, maintenance, insurance, tolls, or other',
      );
    }
    let incurredAt: Date | undefined;
    if (body.incurredAt) {
      incurredAt = new Date(body.incurredAt);
      if (Number.isNaN(incurredAt.getTime())) {
        throw new BadRequestException('incurredAt must be a valid ISO date');
      }
    }
    return this.govService.createDriverExpense({
      driverId: user.userId,
      category: body.category.trim(),
      amount: body.amount,
      description: body.description?.trim() || null,
      incurredAt,
    });
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.DRIVER, UserRole.ADMIN)
  @Get()
  listMine(@CurrentUser() user: { userId: string }) {
    return this.govService.getDriverExpenses(user.userId);
  }
}

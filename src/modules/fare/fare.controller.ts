import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { FareService } from './fare.service';
import { ConfigurationService } from '../subscription/configuration.service';
import {
  FareRateKeys,
  FARE_RATE_DESCRIPTIONS,
} from './fare-rates';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../auth/entities/user-account.entity';
import { zoneIdFor } from '../matching/geo/geo.util';

class GeoPointDto {
  @IsNumber()
  @IsLatitude()
  lat: number;

  @IsNumber()
  @IsLongitude()
  lng: number;
}

class FareEstimateDto {
  @IsNumber()
  @Min(0)
  distanceKm: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  durationMinutes?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  waitMinutes?: number;

  /** Explicit zone — prefer `pickup` so clients need not know cell math. */
  @IsOptional()
  @IsString()
  zoneId?: string;

  /** Pickup pin — used to derive the surge zone (same cell as dispatch). */
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => GeoPointDto)
  pickup?: GeoPointDto;

  @IsOptional()
  @IsString()
  vehicleType?: string;
}

class UpdateFareRatesDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  initialFeeEtb?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  perMeterEtb?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  perMinuteEtb?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  perWaitMinuteEtb?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  minimumEtb?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  surgeMaxMultiplier?: number;
}

@Controller('fare')
export class FareController {
  constructor(
    private readonly fareService: FareService,
    private readonly configuration: ConfigurationService,
  ) {}

  /** Public — Flutter apps load tunable rates from the real DB. */
  @Get('rates')
  rates() {
    return this.fareService.ratesPublicView();
  }

  @Post('estimate')
  async estimate(@Body() dto: FareEstimateDto) {
    const durationMinutes =
      dto.durationMinutes ??
      this.fareService.estimateDurationMinutes(dto.distanceKm);
    const zoneId =
      dto.zoneId ?? (dto.pickup ? zoneIdFor(dto.pickup) : undefined);
    return this.fareService.calculate({
      distanceKm: dto.distanceKm,
      durationMinutes,
      waitMinutes: dto.waitMinutes,
      zoneId,
      vehicleType: dto.vehicleType,
    });
  }

  /** Ops/admin — change initial fee / per-meter without a code deploy. */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch('rates')
  async updateRates(@Body() dto: UpdateFareRatesDto) {
    const mapping: Array<[keyof UpdateFareRatesDto, string]> = [
      ['initialFeeEtb', FareRateKeys.initialFeeEtb],
      ['perMeterEtb', FareRateKeys.perMeterEtb],
      ['perMinuteEtb', FareRateKeys.perMinuteEtb],
      ['perWaitMinuteEtb', FareRateKeys.perWaitMinuteEtb],
      ['minimumEtb', FareRateKeys.minimumEtb],
      ['surgeMaxMultiplier', FareRateKeys.surgeMaxMultiplier],
    ];

    for (const [field, key] of mapping) {
      const value = dto[field];
      if (typeof value === 'number') {
        await this.configuration.set(
          key,
          value,
          FARE_RATE_DESCRIPTIONS[key as keyof typeof FARE_RATE_DESCRIPTIONS],
        );
      }
    }

    return this.fareService.ratesPublicView();
  }
}

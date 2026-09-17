import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
} from 'class-validator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../auth/entities/user-account.entity';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RidesService } from './rides.service';

class SetPresenceDto {
  @IsBoolean()
  online: boolean;

  @IsOptional()
  @IsString()
  connectedAccountId?: string;
}

class DriverServicePreferencesDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(['moto', 'sedan', 'suv'], { each: true })
  acceptedVehicleTypes: string[];
}

/**
 * Driver marketplace presence. Separated from /rides/:id so Nest never
 * treats "driver" as a ride id.
 */
@Controller('drivers')
export class DriverPresenceController {
  constructor(private readonly ridesService: RidesService) {}

  /** Subscription-gated: only active subscribers can go online. */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.DRIVER, UserRole.ADMIN)
  @Post('presence')
  setPresence(
    @CurrentUser() user: { userId: string },
    @Body() body: SetPresenceDto,
  ) {
    return this.ridesService.setDriverPresence(
      user.userId,
      body.online,
      body.connectedAccountId,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('presence')
  getPresence(@CurrentUser() user: { userId: string }) {
    return this.ridesService.getDriverPresence(user.userId);
  }

  /** Categories the driver's verified vehicle can serve, plus their choices. */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.DRIVER, UserRole.ADMIN)
  @Get('service-preferences')
  getServicePreferences(@CurrentUser() user: { userId: string }) {
    return this.ridesService.getDriverServicePreferences(user.userId);
  }

  /** Drivers may opt out of eligible categories; they cannot opt into more. */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.DRIVER, UserRole.ADMIN)
  @Patch('service-preferences')
  setServicePreferences(
    @CurrentUser() user: { userId: string },
    @Body() body: DriverServicePreferencesDto,
  ) {
    return this.ridesService.setDriverServicePreferences(
      user.userId,
      body.acceptedVehicleTypes,
    );
  }
}

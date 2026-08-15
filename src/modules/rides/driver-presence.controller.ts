import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
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
}

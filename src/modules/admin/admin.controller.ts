import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { AdminService } from './admin.service';
import { RidesService } from '../rides/rides.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../auth/entities/user-account.entity';

class SuspendDriverDto {
  @IsBoolean()
  suspended: boolean;

  @IsOptional()
  @IsString()
  reason?: string;
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly config: ConfigService,
    private readonly rides: RidesService,
  ) {}

  @Get('users')
  listUsers(@Query('role') role?: string) {
    return this.admin.listUsers(role);
  }

  @Get('drivers')
  listDrivers(@Query('limit') limit?: string) {
    return this.admin.listDrivers(limit ? Number(limit) : 50);
  }

  @Get('drivers/:id')
  getDriver(@Param('id') id: string) {
    return this.admin.getDriver(id);
  }

  @Post('drivers/:id/suspend')
  suspend(
    @Param('id') id: string,
    @Body() dto: SuspendDriverDto,
    @CurrentUser() user: { userId: string; roles: string[] },
  ) {
    return this.admin.setDriverSuspended(
      id,
      dto.suspended,
      user.userId,
      user.roles.join(','),
      dto.reason,
    );
  }

  @Get('applications')
  listApplications(@Query('status') status?: string) {
    return this.admin.listApplications(status);
  }

  @Get('applications/:id')
  getApplication(@Param('id') id: string) {
    return this.admin.getApplication(id);
  }

  @Get('search')
  search(@Query('q') q = '') {
    return this.admin.search(q);
  }

  @Get('rides/:id/messages')
  rideChat(@Param('id', ParseUUIDPipe) id: string) {
    return this.rides.listRideMessagesForStaff(id);
  }

  @Get('operations/live')
  liveOps() {
    return this.admin.getLiveOperations();
  }

  /** Idempotent demo rows for portals (KYC queue + sample expenses). */
  @Post('bootstrap-demo')
  bootstrapDemo() {
    if (this.config.get<string>('NODE_ENV') === 'production') {
      throw new BadRequestException('bootstrap-demo disabled in production');
    }
    return this.admin.bootstrapDemo();
  }
}

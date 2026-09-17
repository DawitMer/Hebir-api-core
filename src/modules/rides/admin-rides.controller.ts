import {
  Controller,
  Post,
  Param,
  ParseUUIDPipe,
  Body,
  UseGuards,
} from '@nestjs/common';
import { IsString, IsNotEmpty, IsOptional } from 'class-validator';
import { AdminRidesService } from './admin-rides.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../auth/entities/user-account.entity';

class ForceCancelDto {
  @IsString()
  @IsNotEmpty()
  reason: string;

  @IsString()
  @IsOptional()
  adminNotes?: string;
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.GOV_OFFICER)
@Controller('admin/rides')
export class AdminRidesController {
  constructor(private readonly adminRidesService: AdminRidesService) {}

  @Post(':id/force-cancel')
  forceCancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ForceCancelDto,
    @CurrentUser() user: { userId: string; roles: string[] },
  ) {
    return this.adminRidesService.forceCancelRide(
      id,
      user.userId,
      user.roles.join(','),
      dto.reason,
      dto.adminNotes,
    );
  }
}

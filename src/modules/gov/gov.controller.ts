import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { GovService } from './gov.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../auth/entities/user-account.entity';

function clientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

const EXPENSE_REVIEW_STATUSES = new Set([
  'pending',
  'verified',
  'flagged',
  'rejected',
]);

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.GOV_OFFICER)
@Controller('gov')
export class GovController {
  constructor(private readonly govService: GovService) {}

  @Get('dashboard-stats')
  async dashboardStats(
    @CurrentUser() user: { userId: string },
    @Req() req: Request,
  ) {
    await this.govService.recordAccess(
      user.userId,
      'dashboard-stats',
      undefined,
      clientIp(req),
    );
    return this.govService.getDashboardStats();
  }

  @Get('drivers')
  async listDrivers(
    @CurrentUser() user: { userId: string },
    @Req() req: Request,
    @Query('q') q?: string,
    @Query('tin') tin?: string,
    @Query('name') name?: string,
  ) {
    const searching = Boolean(q?.trim() || tin?.trim() || name?.trim());
    await this.govService.recordAccess(
      user.userId,
      searching ? 'drivers-search' : 'drivers-list',
      searching ? [q, tin, name].filter(Boolean).join('|') : undefined,
      clientIp(req),
    );
    return this.govService.listDrivers({ q, tin, name });
  }

  @Get('drivers/:driverId')
  async getDriver(
    @Param('driverId') driverId: string,
    @CurrentUser() user: { userId: string },
    @Req() req: Request,
  ) {
    await this.govService.recordAccess(
      user.userId,
      'driver-profile',
      driverId,
      clientIp(req),
    );
    return this.govService.getDriver(driverId);
  }

  @Get('expenses')
  async listExpenses(
    @CurrentUser() user: { userId: string },
    @Req() req: Request,
    @Query('limit') limit?: string,
  ) {
    await this.govService.recordAccess(
      user.userId,
      'expenses-list',
      undefined,
      clientIp(req),
    );
    return this.govService.listAllExpenses(limit ? Number(limit) : 300);
  }

  @Patch('expenses/:id/status')
  async setExpenseStatus(
    @Param('id') id: string,
    @Body() body: { status?: string },
    @CurrentUser() user: { userId: string },
    @Req() req: Request,
  ) {
    const status = body?.status?.trim();
    if (!status || !EXPENSE_REVIEW_STATUSES.has(status)) {
      throw new BadRequestException(
        `status must be one of: ${[...EXPENSE_REVIEW_STATUSES].join(', ')}`,
      );
    }
    await this.govService.recordAccess(
      user.userId,
      `expense-${status}`,
      id,
      clientIp(req),
    );
    return this.govService.setExpenseReviewStatus(id, status);
  }

  @Get('access-log')
  async accessLog(
    @CurrentUser() user: { userId: string },
    @Req() req: Request,
    @Query('limit') limit?: string,
  ) {
    await this.govService.recordAccess(
      user.userId,
      'access-log',
      undefined,
      clientIp(req),
    );
    return this.govService.listAccessLogs(limit ? Number(limit) : 200);
  }

  @Get('drivers/:driverId/trips')
  async trips(
    @Param('driverId') driverId: string,
    @CurrentUser() user: { userId: string },
    @Req() req: Request,
  ) {
    await this.govService.recordAccess(
      user.userId,
      'driver-trips',
      driverId,
      clientIp(req),
    );
    return this.govService.getDriverTrips(driverId);
  }

  @Get('drivers/:driverId/earnings')
  async earnings(
    @Param('driverId') driverId: string,
    @CurrentUser() user: { userId: string },
    @Req() req: Request,
  ) {
    await this.govService.recordAccess(
      user.userId,
      'driver-earnings',
      driverId,
      clientIp(req),
    );
    return this.govService.getDriverEarningsReport(driverId);
  }

  @Get('drivers/:driverId/expenses')
  async expenses(
    @Param('driverId') driverId: string,
    @CurrentUser() user: { userId: string },
    @Req() req: Request,
  ) {
    await this.govService.recordAccess(
      user.userId,
      'driver-expenses',
      driverId,
      clientIp(req),
    );
    return this.govService.getDriverExpenses(driverId);
  }
}

import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { GovService } from './gov.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../auth/entities/user-account.entity';
import {
  AssignGovLegalRequestDto,
  CreateGovLegalRequestDto,
  CreateGovReportJobDto,
  GovDriverSearchDto,
  GovExpensesQueryDto,
  GovLimitDto,
  ReviewExpenseDto,
  UpdateGovLegalStatusDto,
} from './gov.dto';

function clientIp(req: Request): string {
  // Express applies the configured trusted-proxy boundary; never trust a
  // caller's raw X-Forwarded-For when recording government access audits.
  return req.ip || req.socket.remoteAddress || 'unknown';
}

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
    @Query() query: GovDriverSearchDto,
  ) {
    const { q, tin, name } = query;
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
    @Param('driverId', ParseUUIDPipe) driverId: string,
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
    @Query() query: GovExpensesQueryDto,
  ) {
    await this.govService.recordAccess(
      user.userId,
      'expenses-list',
      undefined,
      clientIp(req),
    );
    return this.govService.listAllExpenses({
      ...query,
      limit: query.limit ?? 300,
    });
  }

  @Get('expenses/:id')
  async getExpense(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { userId: string },
    @Req() req: Request,
  ) {
    await this.govService.recordAccess(
      user.userId,
      'expense-detail',
      id,
      clientIp(req),
    );
    return this.govService.getMonthlyReportById(id);
  }

  @Patch('expenses/:id/status')
  async setExpenseStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReviewExpenseDto,
    @CurrentUser() user: { userId: string },
    @Req() req: Request,
  ) {
    const status = body.status;
    const reviewerNotes = body?.reviewerNotes?.trim() || body?.notes?.trim();
    await this.govService.recordAccess(
      user.userId,
      `expense-${status}`,
      id,
      clientIp(req),
    );
    return this.govService.setExpenseReviewStatus(
      id,
      status,
      user.userId,
      reviewerNotes,
    );
  }

  @Get('access-log')
  async accessLog(
    @CurrentUser() user: { userId: string },
    @Req() req: Request,
    @Query() query: GovLimitDto,
  ) {
    await this.govService.recordAccess(
      user.userId,
      'access-log',
      undefined,
      clientIp(req),
    );
    return this.govService.listAccessLogs(
      query.limit ?? 200,
      query.before,
    );
  }

  @Get('drivers/:driverId/trips')
  async trips(
    @Param('driverId', ParseUUIDPipe) driverId: string,
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
    @Param('driverId', ParseUUIDPipe) driverId: string,
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
    @Param('driverId', ParseUUIDPipe) driverId: string,
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

  // --- Legal requests ---

  @Get('legal-requests')
  async listLegalRequests(
    @CurrentUser() user: { userId: string },
    @Req() req: Request,
    @Query() query: GovLimitDto,
  ) {
    await this.govService.recordAccess(
      user.userId,
      'legal-requests-list',
      undefined,
      clientIp(req),
    );
    return this.govService.listLegalRequests(query.limit ?? 200);
  }

  @Post('legal-requests')
  async createLegalRequest(
    @Body() body: CreateGovLegalRequestDto,
    @CurrentUser() user: { userId: string },
    @Req() req: Request,
  ) {
    await this.govService.recordAccess(
      user.userId,
      'legal-request-create',
      undefined,
      clientIp(req),
    );
    return this.govService.createLegalRequest(user.userId, body);
  }

  @Get('legal-requests/:id')
  async getLegalRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { userId: string },
    @Req() req: Request,
  ) {
    await this.govService.recordAccess(
      user.userId,
      'legal-request-detail',
      id,
      clientIp(req),
    );
    return this.govService.getLegalRequest(id);
  }

  @Patch('legal-requests/:id/status')
  async updateLegalStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateGovLegalStatusDto,
    @CurrentUser() user: { userId: string },
    @Req() req: Request,
  ) {
    await this.govService.recordAccess(
      user.userId,
      `legal-request-${body.status}`,
      id,
      clientIp(req),
    );
    return this.govService.updateLegalRequestStatus(id, user.userId, body);
  }

  @Post('legal-requests/:id/assign')
  async assignLegalRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AssignGovLegalRequestDto,
    @CurrentUser() user: { userId: string },
    @Req() req: Request,
  ) {
    await this.govService.recordAccess(
      user.userId,
      'legal-request-assign',
      id,
      clientIp(req),
    );
    return this.govService.assignLegalRequest(id, user.userId, body);
  }

  // --- Report jobs ---

  @Get('reports')
  async listReports(
    @CurrentUser() user: { userId: string },
    @Req() req: Request,
    @Query() query: GovLimitDto,
  ) {
    await this.govService.recordAccess(
      user.userId,
      'reports-list',
      undefined,
      clientIp(req),
    );
    return this.govService.listReportJobs(query.limit ?? 100);
  }

  @Post('reports')
  async createReport(
    @Body() body: CreateGovReportJobDto,
    @CurrentUser() user: { userId: string },
    @Req() req: Request,
  ) {
    await this.govService.recordAccess(
      user.userId,
      'report-create',
      body.driverId,
      clientIp(req),
    );
    return this.govService.createReportJob(user.userId, body);
  }

  @Get('reports/:id')
  async getReport(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { userId: string },
    @Req() req: Request,
  ) {
    await this.govService.recordAccess(
      user.userId,
      'report-detail',
      id,
      clientIp(req),
    );
    return this.govService.getReportJob(id);
  }

  @Get('reports/:id/download')
  @Header('Cache-Control', 'no-store')
  async downloadReport(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { userId: string },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.govService.recordAccess(
      user.userId,
      'report-download',
      id,
      clientIp(req),
    );
    const { csv, filename } = await this.govService.downloadReportJob(id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename.replace(/"/g, '')}"`,
    );
    res.send(csv);
  }
}

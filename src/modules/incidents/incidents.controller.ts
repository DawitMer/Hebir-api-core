import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { IncidentsService } from './incidents.service';
import {
  CreateIncidentDto,
  CreateSosDto,
  UpdateIncidentStatusDto,
} from './dto/incident.dto';
import { IncidentStatus } from './entities/incident.entity';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../auth/entities/user-account.entity';

@Controller()
export class IncidentsController {
  constructor(private readonly incidents: IncidentsService) {}

  /** Rider / Driver SOS — creates a critical open incident. */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.RIDER, UserRole.DRIVER, UserRole.ADMIN)
  @Post('incidents/sos')
  sos(
    @CurrentUser() user: { userId: string; roles: string[] },
    @Body() dto: CreateSosDto,
  ) {
    const role = user.roles?.includes(UserRole.DRIVER)
      ? 'driver'
      : user.roles?.includes(UserRole.RIDER)
        ? 'rider'
        : 'admin';
    return this.incidents.createSos(user.userId, role, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.RIDER, UserRole.DRIVER, UserRole.ADMIN)
  @Post('incidents')
  create(
    @CurrentUser() user: { userId: string; roles: string[] },
    @Body() dto: CreateIncidentDto,
  ) {
    const role = user.roles?.[0] ?? 'rider';
    return this.incidents.createReport(user.userId, role, dto);
  }

  /** Ops portal queue — matches `/operations/incidents`. */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get('operations/incidents')
  list(@Query('status') status?: IncidentStatus) {
    return this.incidents.list(status);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get('operations/incidents/:caseNumber')
  detail(@Param('caseNumber') caseNumber: string) {
    return this.incidents.getByCaseNumber(caseNumber);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch('operations/incidents/:caseNumber/status')
  updateStatus(
    @Param('caseNumber') caseNumber: string,
    @Body() dto: UpdateIncidentStatusDto,
    @CurrentUser() user: { userId: string },
  ) {
    return this.incidents.updateStatus(caseNumber, dto, user.userId, dto.assignedToName);
  }
}

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { GovAccessLog } from './entities/access-log.entity';
import {
  DriverMonthlyExpenseReport,
  MonthlyExpenseStatus,
} from './entities/driver-monthly-expense-report.entity';
import {
  GovLegalRequest,
  GovLegalRequestPriority,
  GovLegalRequestStatus,
  GovLegalRequestType,
} from './entities/gov-legal-request.entity';
import { GovLegalRequestEvent } from './entities/gov-legal-request-event.entity';
import {
  GovReportJob,
  GovReportJobStatus,
} from './entities/gov-report-job.entity';
import { Booking, BookingStatus } from '../booking/entities/booking.entity';
import {
  DriverSubscription,
  SubscriptionState,
} from '../subscription/entities/driver-subscription.entity';
import { Trip } from '../matching/entities/trip.entity';
import { RiderRequest } from '../matching/entities/rider-request.entity';
import {
  AccountStanding,
  UserAccount,
  UserRole,
} from '../auth/entities/user-account.entity';
import { Vehicle } from '../rides/entities/vehicle.entity';
import { Ride, RideStatus } from '../rides/entities/ride.entity';
import { FareRecord } from '../rides/entities/fare-record.entity';
import {
  DriverVerification,
  VerificationStatus,
} from '../kyc/entities/driver-verification.entity';
import { NotificationsGateway } from '../notifications/notifications.gateway';
import { PushService } from '../push/push.service';
import {
  assertLegalStatusTransition,
  canAssignLegalRequest,
} from './legal-request-policy';
import type {
  AssignGovLegalRequestDto,
  CreateGovLegalRequestDto,
  CreateGovReportJobDto,
  UpdateGovLegalStatusDto,
} from './gov.dto';

/** Compliance reports are paged in the portal; this bounds one page. */
const MAX_REPORT_ROWS = 100;
/** Name/TIN search must never dump the fleet — portal shows a hit list. */
const MAX_SEARCH_HITS = 40;

/** Strip LIKE wildcards from user input (safer than ESCAPE with TypeORM). */
function sanitizeSearchTerm(raw: string): string {
  return raw.replace(/[%_\\]/g, '').trim();
}

@Injectable()
export class GovService {
  constructor(
    @InjectRepository(GovAccessLog)
    private readonly accessLogs: Repository<GovAccessLog>,
    @InjectRepository(DriverMonthlyExpenseReport)
    private readonly monthlyReports: Repository<DriverMonthlyExpenseReport>,
    @InjectRepository(GovLegalRequest)
    private readonly legalRequests: Repository<GovLegalRequest>,
    @InjectRepository(GovLegalRequestEvent)
    private readonly legalEvents: Repository<GovLegalRequestEvent>,
    @InjectRepository(GovReportJob)
    private readonly reportJobs: Repository<GovReportJob>,
    @InjectRepository(Booking) private readonly bookings: Repository<Booking>,
    @InjectRepository(DriverSubscription)
    private readonly subscriptions: Repository<DriverSubscription>,
    @InjectRepository(Trip) private readonly trips: Repository<Trip>,
    @InjectRepository(RiderRequest)
    private readonly riderRequests: Repository<RiderRequest>,
    @InjectRepository(UserAccount)
    private readonly users: Repository<UserAccount>,
    @InjectRepository(Vehicle) private readonly vehicles: Repository<Vehicle>,
    @InjectRepository(Ride) private readonly rides: Repository<Ride>,
    @InjectRepository(FareRecord)
    private readonly fares: Repository<FareRecord>,
    @InjectRepository(DriverVerification)
    private readonly verifications: Repository<DriverVerification>,
    private readonly notifications: NotificationsGateway,
    private readonly push: PushService,
  ) {}

  async recordAccess(
    officerId: string,
    resource: string,
    resourceId?: string,
    ipAddress?: string,
  ) {
    await this.accessLogs.save(
      this.accessLogs.create({
        officerId,
        resource,
        resourceId: resourceId ?? null,
        ipAddress: ipAddress ?? null,
      }),
    );
  }

  async listAccessLogs(limit = 200, before?: string) {
    const take = Math.max(1, Math.min(500, limit));
    const qb = this.accessLogs
      .createQueryBuilder('l')
      .orderBy('l.accessedAt', 'DESC')
      .addOrderBy('l.id', 'DESC')
      .take(take);
    if (before) {
      const cursor = await this.accessLogs.findOne({ where: { id: before } });
      if (!cursor) throw new BadRequestException('Invalid access-log cursor');
      qb.andWhere(
        '(l."accessedAt", l.id) < (:accessedAt, :id)',
        { accessedAt: cursor.accessedAt, id: cursor.id },
      );
    }
    const rows = await qb.getMany();
    const officerIds = [...new Set(rows.map((r) => r.officerId))];
    const officers = officerIds.length
      ? await this.users.find({ where: { id: In(officerIds) } })
      : [];
    const byId = new Map(officers.map((o) => [o.id, o]));

    return rows.map((r) => {
      const officer = byId.get(r.officerId);
      return {
        id: r.id,
        timestamp: r.accessedAt.toISOString(),
        action: r.resource,
        resourceId: r.resourceId ?? '—',
        ipAddress: r.ipAddress || 'unknown',
        status: 'success' as const,
        officerName: officer?.fullName || officer?.phoneNumber || r.officerId,
      };
    });
  }

  async listDrivers(filters?: { q?: string; tin?: string; name?: string }) {
    const q = sanitizeSearchTerm(filters?.q ?? '');
    const tin = sanitizeSearchTerm(filters?.tin ?? '');
    const name = sanitizeSearchTerm(filters?.name ?? '');
    const searching = Boolean(q || tin || name);
    // TypeORM take(0) removes the limit; never issue an unfiltered roster query.
    if (!searching) return [];

    const qb = this.users
      .createQueryBuilder('u')
      .where(':role = ANY(u.roles)', { role: UserRole.DRIVER });

    if (tin) {
      // Prefix match prefers the unique TIN index.
      qb.andWhere('u.tin ILIKE :tin', { tin: `${tin}%` });
    }
    if (name) {
      qb.andWhere('u.fullName ILIKE :name', { name: `%${name}%` });
    }
    if (q) {
      qb.andWhere(
        `(u.fullName ILIKE :needle
          OR u.tin ILIKE :prefix
          OR u.tin ILIKE :needle
          OR u.phoneNumber ILIKE :needle)`,
        { needle: `%${q}%`, prefix: `${q}%` },
      );
    }

    const drivers = await qb
      .orderBy('u.fullName', 'ASC')
      .addOrderBy('u.createdAt', 'DESC')
      .take(MAX_SEARCH_HITS)
      .getMany();

    return this.mapDriverRows(drivers);
  }

  async getDriver(driverId: string) {
    const user = await this.users.findOne({ where: { id: driverId } });
    if (!user || !user.roles?.includes(UserRole.DRIVER)) {
      throw new NotFoundException('Driver not found');
    }
    const [row] = await this.mapDriverRows([user]);
    return row;
  }

  private async mapDriverRows(drivers: UserAccount[]) {
    const vehicles =
      drivers.length === 0
        ? []
        : await this.vehicles.find({
            where: { driverId: In(drivers.map((d) => d.id)) },
          });
    const vehicleByDriver = new Map(vehicles.map((v) => [v.driverId, v]));

    // Compliance requires an APPROVED KYC verification, not just account standing.
    const approvedKyc = new Set(
      drivers.length === 0
        ? []
        : (
            await this.verifications.find({
              where: {
                driverId: In(drivers.map((d) => d.id)),
                status: VerificationStatus.APPROVED,
              },
              select: { driverId: true },
            })
          ).map((v) => v.driverId),
    );

    return drivers.map((d) => {
      const vehicle = vehicleByDriver.get(d.id);
      return {
        id: d.id,
        tin: d.tin ?? null,
        fullName: d.fullName || d.phoneNumber,
        vehicleType: vehicle ? `${vehicle.make} ${vehicle.model}`.trim() : '—',
        status:
          d.standing === AccountStanding.GOOD && approvedKyc.has(d.id)
            ? ('compliant' as const)
            : ('pendingAudit' as const),
        fiscalYear: new Date().getFullYear(),
      };
    });
  }

  private normalizeReviewStatus(raw: string): MonthlyExpenseStatus {
    const s = raw.trim().toLowerCase();
    switch (s) {
      case 'verified':
      case 'approved':
        return MonthlyExpenseStatus.APPROVED;
      case 'rejected':
        return MonthlyExpenseStatus.REJECTED;
      case 'flagged':
      case 'changes_required':
        return MonthlyExpenseStatus.CHANGES_REQUIRED;
      case 'under_review':
        return MonthlyExpenseStatus.UNDER_REVIEW;
      case 'draft':
        return MonthlyExpenseStatus.DRAFT;
      case 'pending':
      case 'submitted':
      default:
        return MonthlyExpenseStatus.SUBMITTED;
    }
  }

  async submitMonthlyExpenseReport(
    driverId: string,
    input: {
      reportingMonth?: string;
      fuelAmount?: number;
      maintenanceAmount?: number;
      insuranceAmount?: number;
      tollsAmount?: number;
      otherAmount?: number;
      totalAmount?: number;
      notes?: string;
      isDraft?: boolean;
      category?: string;
      amount?: number;
      description?: string;
    },
  ) {
    const window = await this.getDriverExpenseReportingWindow(driverId);
    let month = input.reportingMonth?.trim();
    if (!month && window.months.length) {
      month = window.months[0];
    }
    if (!month || !window.months.includes(month)) {
      throw new BadRequestException(
        window.months.length === 0
          ? 'There are no completed reporting months available yet. Expense reporting opens after your first full calendar month.'
          : `Expenses may only be reported for completed months from your signup month through ${window.lastEligibleMonth}.`,
      );
    }

    let fuel = input.fuelAmount ?? 0;
    let maint = input.maintenanceAmount ?? 0;
    let insur = input.insuranceAmount ?? 0;
    let tolls = input.tollsAmount ?? 0;
    let other = input.otherAmount ?? 0;

    // Handle legacy single-expense payload if provided
    if (input.category && input.amount) {
      const cat = input.category.toLowerCase();
      if (cat.includes('fuel')) fuel += input.amount;
      else if (cat.includes('maint')) maint += input.amount;
      else if (cat.includes('insur')) insur += input.amount;
      else if (cat.includes('toll') || cat.includes('park'))
        tolls += input.amount;
      else other += input.amount;
    }

    let total = fuel + maint + insur + tolls + other;
    if (total === 0 && input.totalAmount && input.totalAmount > 0) {
      total = input.totalAmount;
      other = input.totalAmount;
    }

    const notes = input.notes?.trim() || input.description?.trim() || null;
    const isDraft = Boolean(input.isDraft);

    // Check for existing report for this driver and month to prevent duplicates
    const existing = await this.monthlyReports.findOne({
      where: { driverId, reportingMonth: month },
    });

    if (existing) {
      if (
        existing.status === MonthlyExpenseStatus.DRAFT ||
        existing.status === MonthlyExpenseStatus.CHANGES_REQUIRED
      ) {
        existing.fuelAmount = fuel.toFixed(2);
        existing.maintenanceAmount = maint.toFixed(2);
        existing.insuranceAmount = insur.toFixed(2);
        existing.tollsAmount = tolls.toFixed(2);
        existing.otherAmount = other.toFixed(2);
        existing.totalAmount = total.toFixed(2);
        existing.notes = notes;
        existing.status = isDraft
          ? MonthlyExpenseStatus.DRAFT
          : MonthlyExpenseStatus.SUBMITTED;
        existing.submittedAt = isDraft ? existing.submittedAt : new Date();
        return this.monthlyReports.save(existing);
      }

      if (
        existing.status === MonthlyExpenseStatus.SUBMITTED ||
        existing.status === MonthlyExpenseStatus.UNDER_REVIEW
      ) {
        throw new ConflictException(
          `A monthly expense report for ${month} has already been submitted and is currently ${existing.status === MonthlyExpenseStatus.UNDER_REVIEW ? 'under review' : 'pending review'}.`,
        );
      }

      if (existing.status === MonthlyExpenseStatus.APPROVED) {
        throw new ConflictException(
          `A monthly expense report for ${month} has already been approved.`,
        );
      }

      if (existing.status === MonthlyExpenseStatus.REJECTED) {
        throw new ConflictException(
          `The expense report for ${month} was rejected. Please contact an officer or support to request changes.`,
        );
      }
    }

    const report = this.monthlyReports.create({
      driverId,
      reportingMonth: month,
      status: isDraft
        ? MonthlyExpenseStatus.DRAFT
        : MonthlyExpenseStatus.SUBMITTED,
      fuelAmount: fuel.toFixed(2),
      maintenanceAmount: maint.toFixed(2),
      insuranceAmount: insur.toFixed(2),
      tollsAmount: tolls.toFixed(2),
      otherAmount: other.toFixed(2),
      totalAmount: total.toFixed(2),
      notes,
      submittedAt: isDraft ? null : new Date(),
    });

    return this.monthlyReports.save(report);
  }

  async updateMonthlyExpenseReport(
    driverId: string,
    reportId: string,
    input: {
      fuelAmount?: number;
      maintenanceAmount?: number;
      insuranceAmount?: number;
      tollsAmount?: number;
      otherAmount?: number;
      totalAmount?: number;
      notes?: string;
      submit?: boolean;
    },
  ) {
    const report = await this.monthlyReports.findOne({
      where: { id: reportId, driverId },
    });
    if (!report) {
      throw new NotFoundException('Monthly expense report not found');
    }

    if (report.status === MonthlyExpenseStatus.APPROVED) {
      throw new BadRequestException(
        'Cannot modify an approved expense report.',
      );
    }
    if (
      report.status === MonthlyExpenseStatus.SUBMITTED ||
      report.status === MonthlyExpenseStatus.UNDER_REVIEW
    ) {
      throw new BadRequestException(
        'This report is currently under review. Editing is permitted when in draft or when changes are requested.',
      );
    }

    if (input.fuelAmount !== undefined)
      report.fuelAmount = input.fuelAmount.toFixed(2);
    if (input.maintenanceAmount !== undefined)
      report.maintenanceAmount = input.maintenanceAmount.toFixed(2);
    if (input.insuranceAmount !== undefined)
      report.insuranceAmount = input.insuranceAmount.toFixed(2);
    if (input.tollsAmount !== undefined)
      report.tollsAmount = input.tollsAmount.toFixed(2);
    if (input.otherAmount !== undefined)
      report.otherAmount = input.otherAmount.toFixed(2);

    const fuel = Number(report.fuelAmount) || 0;
    const maint = Number(report.maintenanceAmount) || 0;
    const insur = Number(report.insuranceAmount) || 0;
    const tolls = Number(report.tollsAmount) || 0;
    const other = Number(report.otherAmount) || 0;

    report.totalAmount = (fuel + maint + insur + tolls + other).toFixed(2);
    if (input.notes !== undefined) report.notes = input.notes.trim() || null;

    if (input.submit) {
      report.status = MonthlyExpenseStatus.SUBMITTED;
      report.submittedAt = new Date();
    }

    return this.monthlyReports.save(report);
  }

  async listDriverMonthlyReports(driverId: string) {
    const window = await this.getDriverExpenseReportingWindow(driverId);
    if (window.months.length === 0) return [];
    const rows = await this.monthlyReports
      .createQueryBuilder('report')
      .where('report."driverId" = :driverId', { driverId })
      .andWhere('report."reportingMonth" >= :firstEligibleMonth', {
        firstEligibleMonth: window.firstEligibleMonth,
      })
      .andWhere('report."reportingMonth" <= :lastEligibleMonth', {
        lastEligibleMonth: window.lastEligibleMonth,
      })
      .orderBy('report."reportingMonth"', 'DESC')
      .addOrderBy('report."createdAt"', 'DESC')
      .take(MAX_REPORT_ROWS)
      .getMany();
    return rows.map((r) => ({
      ...r,
      fiscalMonth: r.reportingMonth,
      amount: Number(r.totalAmount),
      category: 'Monthly Summary',
      description: r.notes || `Expense report for ${r.reportingMonth}`,
      incurredAt: r.submittedAt || r.createdAt,
      reviewStatus: r.status,
    }));
  }

  /**
   * A driver may report only full, completed calendar months, beginning with
   * the calendar month in which their account was created.  The server owns
   * this rule so the mobile app and portals cannot expose invented, future,
   * or pre-signup periods.
   */
  async getDriverExpenseReportingWindow(driverId: string) {
    const driver = await this.users.findOne({
      where: { id: driverId },
      select: { id: true, createdAt: true },
    });
    if (!driver) throw new NotFoundException('Driver not found');

    const signupMonth = `${driver.createdAt.getUTCFullYear()}-${String(
      driver.createdAt.getUTCMonth() + 1,
    ).padStart(2, '0')}`;
    const now = new Date();
    const lastCompleted = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0),
    );
    const lastEligibleMonth = `${lastCompleted.getUTCFullYear()}-${String(
      lastCompleted.getUTCMonth() + 1,
    ).padStart(2, '0')}`;
    const months: string[] = [];
    if (signupMonth <= lastEligibleMonth) {
      for (
        let cursor = new Date(
          Date.UTC(
            driver.createdAt.getUTCFullYear(),
            driver.createdAt.getUTCMonth(),
            1,
          ),
        );
        cursor <= lastCompleted;
        cursor = new Date(
          Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1),
        )
      ) {
        months.push(
          `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`,
        );
      }
    }

    return {
      firstEligibleMonth: months[0] ?? null,
      lastEligibleMonth: months[months.length - 1] ?? null,
      months: months.reverse(),
    };
  }

  async getDriverMonthlyReport(driverId: string, reportId: string) {
    const report = await this.monthlyReports.findOne({
      where: { id: reportId, driverId },
    });
    if (!report) {
      throw new NotFoundException('Expense report not found');
    }
    return {
      ...report,
      fiscalMonth: report.reportingMonth,
      amount: Number(report.totalAmount),
      category: 'Monthly Summary',
      description:
        report.notes || `Expense report for ${report.reportingMonth}`,
      incurredAt: report.submittedAt || report.createdAt,
      reviewStatus: report.status,
    };
  }

  async getMonthlyReportById(reportId: string) {
    const report = await this.monthlyReports.findOne({
      where: { id: reportId },
      relations: { driver: true, reviewer: true },
    });
    if (!report) {
      throw new NotFoundException('Expense report not found');
    }
    return {
      ...report,
      driverName: report.driver?.fullName || report.driver?.phoneNumber || null,
      driverTin: report.driver?.tin || null,
      driverPhone: report.driver?.phoneNumber || null,
      reviewerName: report.reviewer?.fullName || null,
      fiscalMonth: report.reportingMonth,
      amount: Number(report.totalAmount),
      category: 'Monthly Summary',
      description:
        report.notes || `Expense report for ${report.reportingMonth}`,
      incurredAt: report.submittedAt || report.createdAt,
      reviewStatus: report.status,
    };
  }

  async listAllExpenses(options?: {
    status?: string;
    month?: string;
    search?: string;
    limit?: number;
    before?: string;
  }) {
    const now = new Date();
    const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const limit = Math.max(1, Math.min(500, options?.limit ?? 300));
    const isFilterNotSubmitted = options?.status === 'not_submitted';

    const qb = this.monthlyReports
      .createQueryBuilder('r')
      .leftJoinAndSelect('r.driver', 'driver')
      .leftJoinAndSelect('r.reviewer', 'reviewer')
      .where('r.reportingMonth <= :currentMonth', { currentMonth })
      .orderBy('r.reportingMonth', 'DESC')
      .addOrderBy('r.updatedAt', 'DESC')
      .addOrderBy('r.id', 'DESC')
      .take(limit);

    if (options?.before) {
      const cursor = await this.monthlyReports.findOne({
        where: { id: options.before },
      });
      if (!cursor) throw new BadRequestException('Invalid expense cursor');
      qb.andWhere(
        '(r."reportingMonth", r."updatedAt", r.id) < (:month, :updatedAt, :id)',
        {
          month: cursor.reportingMonth,
          updatedAt: cursor.updatedAt,
          id: cursor.id,
        },
      );
    }

    if (options?.status && options.status !== 'all' && !isFilterNotSubmitted) {
      const mapped = this.normalizeReviewStatus(options.status);
      qb.andWhere('r.status = :status', { status: mapped });
    }
    if (options?.month) {
      qb.andWhere('r.reportingMonth = :month', { month: options.month });
    }
    if (options?.search) {
      const s = sanitizeSearchTerm(options.search);
      if (s) {
        qb.andWhere(
          '(driver.fullName ILIKE :s OR driver.tin ILIKE :s OR driver.phoneNumber ILIKE :s)',
          { s: `%${s}%` },
        );
      }
    }

    const rows = isFilterNotSubmitted ? [] : await qb.getMany();
    const mappedRows = rows.map((r) => ({
      id: r.id,
      driverId: r.driverId,
      driverTin: r.driver?.tin ?? null,
      driverName: r.driver?.fullName ?? r.driver?.phoneNumber ?? null,
      driverPhone: r.driver?.phoneNumber ?? null,
      reportingMonth: r.reportingMonth,
      fiscalMonth: r.reportingMonth,
      status: r.status,
      fuelAmount: Number(r.fuelAmount),
      maintenanceAmount: Number(r.maintenanceAmount),
      insuranceAmount: Number(r.insuranceAmount),
      tollsAmount: Number(r.tollsAmount),
      otherAmount: Number(r.otherAmount),
      totalAmount: Number(r.totalAmount),
      amount: Number(r.totalAmount),
      category: 'Monthly Summary',
      description: r.notes || `Monthly summary for ${r.reportingMonth}`,
      notes: r.notes,
      reviewerId: r.reviewerId,
      reviewerName: r.reviewer?.fullName ?? null,
      reviewerNotes: r.reviewerNotes,
      reviewedAt: r.reviewedAt,
      submittedAt: r.submittedAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      incurredAt: r.submittedAt || r.createdAt,
      reviewStatus: r.status,
    }));

    // If viewing unsubmitted or all, detect active drivers who have not submitted for target month
    if (
      isFilterNotSubmitted ||
      (options?.month && (!options?.status || options.status === 'all'))
    ) {
      const targetMonth = options?.month ?? currentMonth;
      if (targetMonth <= currentMonth) {
        const submittedDriverIds = new Set(
          (
            await this.monthlyReports.find({
              where: { reportingMonth: targetMonth },
            })
          ).map((r) => r.driverId),
        );

        const driversQb = this.users
          .createQueryBuilder('u')
          .where(':role = ANY(u.roles)', { role: UserRole.DRIVER });

        if (options?.search) {
          const s = sanitizeSearchTerm(options.search);
          if (s) {
            driversQb.andWhere(
              '(u.fullName ILIKE :s OR u.tin ILIKE :s OR u.phoneNumber ILIKE :s)',
              { s: `%${s}%` },
            );
          }
        }

        const allDrivers = await driversQb.getMany();
        const unsubmittedDrivers = allDrivers.filter(
          (d) => !submittedDriverIds.has(d.id),
        );

        const unsubmittedRows = unsubmittedDrivers.map((d) => ({
          id: `unsubmitted-${d.id}-${targetMonth}`,
          driverId: d.id,
          driverTin: d.tin ?? null,
          driverName: d.fullName ?? d.phoneNumber ?? null,
          driverPhone: d.phoneNumber ?? null,
          reportingMonth: targetMonth,
          fiscalMonth: targetMonth,
          status: 'not_submitted',
          fuelAmount: 0,
          maintenanceAmount: 0,
          insuranceAmount: 0,
          tollsAmount: 0,
          otherAmount: 0,
          totalAmount: 0,
          amount: 0,
          category: 'Monthly Summary',
          description: `Report not yet submitted for ${targetMonth}`,
          notes: null,
          reviewerId: null,
          reviewerName: null,
          reviewerNotes: null,
          reviewedAt: null,
          submittedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          incurredAt: null,
          reviewStatus: 'not_submitted',
        }));

        return isFilterNotSubmitted
          ? unsubmittedRows
          : [...mappedRows, ...unsubmittedRows];
      }
    }

    return mappedRows;
  }

  async setExpenseReviewStatus(
    expenseId: string,
    rawStatus: string,
    reviewerId?: string,
    reviewerNotes?: string,
  ) {
    const status = this.normalizeReviewStatus(rawStatus);

    const report = await this.monthlyReports.findOne({
      where: { id: expenseId },
    });

    if (report) {
      report.status = status;
      if (reviewerId) report.reviewerId = reviewerId;
      if (reviewerNotes !== undefined) report.reviewerNotes = reviewerNotes;
      report.reviewedAt = new Date();
      const saved = await this.monthlyReports.save(report);

      try {
        if (status === MonthlyExpenseStatus.APPROVED) {
          await this.notifications.notify(report.driverId, 'expense.approved', {
            reportId: report.id,
            month: report.reportingMonth,
            totalAmount: report.totalAmount,
          });
          await this.push.send(
            report.driverId,
            'expense.approved',
            'Monthly Expense Approved',
            `Your expense report for ${report.reportingMonth} has been approved.`,
            { reportId: report.id, month: report.reportingMonth },
          );
        } else if (status === MonthlyExpenseStatus.REJECTED) {
          await this.notifications.notify(report.driverId, 'expense.rejected', {
            reportId: report.id,
            month: report.reportingMonth,
            reason: reviewerNotes,
          });
          await this.push.send(
            report.driverId,
            'expense.rejected',
            'Monthly Expense Rejected',
            `Your expense report for ${report.reportingMonth} was rejected${reviewerNotes ? ': ' + reviewerNotes : '.'}`,
            {
              reportId: report.id,
              month: report.reportingMonth,
              reason: reviewerNotes,
            },
          );
        } else if (status === MonthlyExpenseStatus.CHANGES_REQUIRED) {
          await this.notifications.notify(
            report.driverId,
            'expense.changes_requested',
            {
              reportId: report.id,
              month: report.reportingMonth,
              reason: reviewerNotes,
            },
          );
          await this.push.send(
            report.driverId,
            'expense.changes_requested',
            'Action Required: Expense Changes Requested',
            `Please update your ${report.reportingMonth} expense report${reviewerNotes ? ': ' + reviewerNotes : '.'}`,
            {
              reportId: report.id,
              month: report.reportingMonth,
              reason: reviewerNotes,
            },
          );
        }
      } catch {
        // Notification delivery is best effort
      }

      return saved;
    }

    throw new NotFoundException('Expense report not found');
  }

  /** Legacy driver self-service adapter. */
  async createDriverExpense(input: {
    driverId: string;
    category: string;
    amount: number;
    description: string | null;
    incurredAt?: Date;
  }) {
    return this.submitMonthlyExpenseReport(input.driverId, {
      category: input.category,
      amount: input.amount,
      description: input.description ?? undefined,
    });
  }

  async getDriverTrips(driverId: string) {
    const rides = await this.rides.find({
      where: { driverId, status: RideStatus.COMPLETED },
      order: { completedAt: 'DESC' },
      take: 100,
    });
    const fareByRide =
      rides.length === 0
        ? []
        : await this.fares.find({
            where: { rideId: In(rides.map((r) => r.id)) },
          });
    const fareMap = new Map(fareByRide.map((f) => [f.rideId, f]));

    return {
      driverId,
      sampleLimit: 100,
      totalTrips: await this.rides.count({
        where: { driverId, status: RideStatus.COMPLETED },
      }),
      totalGross: Number(
        (
          await this.fares
            .createQueryBuilder('f')
            .innerJoin(Ride, 'r', 'r.id = f.rideId')
            .where('r.driverId = :driverId AND r.status = :status', {
              driverId,
              status: RideStatus.COMPLETED,
            })
            .select('COALESCE(SUM(f.total::numeric), 0)', 'total')
            .getRawOne()
        )?.total ?? 0,
      ),
      trips: rides.map((r) => {
        const fare = fareMap.get(r.id);
        return {
          id: r.id,
          status: r.status,
          pickup: r.pickupAddress,
          dropoff: r.dropoffAddress,
          completedAt: r.completedAt,
          distanceM: r.actualDistanceM ?? r.distanceM,
          durationS: r.actualDurationS ?? r.durationS,
          fareTotal: fare ? Number(fare.total) : 0,
        };
      }),
    };
  }

  async getDriverEarningsReport(driverId: string, fiscalYear?: number) {
    const driver = await this.users.findOne({ where: { id: driverId } });
    if (!driver) throw new NotFoundException('Driver not found');

    const now = new Date();
    const year = fiscalYear ?? now.getUTCFullYear();
    const isCurrentYear = year === now.getUTCFullYear();
    const lastMonthIdx = isCurrentYear ? now.getUTCMonth() : 11;
    const currentMonthStr = isCurrentYear
      ? `${year}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
      : null;
    const start = new Date(Date.UTC(year, 0, 1));
    const nextMonthStart = new Date(Date.UTC(year, lastMonthIdx + 1, 1));

    // Aggregate in SQL strictly up to current month (ended months + current unsubmitted month)
    const rows = (await this.rides.manager.query(
      `
      WITH revenue AS (
        SELECT r."completedAt" AS at, f.total::numeric AS gross,
          f."platformFee"::numeric AS fee, 1 AS trips
        FROM rides r JOIN fares f ON f."rideId" = r.id
        WHERE r."driverId" = $1 AND r.status = 'completed'
        UNION ALL
        SELECT b."createdAt", b."calculatedFare"::numeric, 0, 1
        FROM bookings b JOIN trips t ON t.id = b."tripId"
        WHERE t."driverId" = $1 AND b.status = 'confirmed'
        UNION ALL
        SELECT t."createdAt", t.amount::numeric, 0, 0 FROM tips t
        WHERE t."driverId" = $1 AND t.status = 'succeeded'
      ), months AS (
        SELECT month::date AS month
        FROM generate_series(
          make_date($2::int, 1, 1),
          make_date($2::int, $3::int, 1),
          interval '1 month'
        ) AS month
      )
      SELECT to_char(m.month, 'YYYY-MM') AS month,
        COALESCE((SELECT SUM(gross) FROM revenue WHERE at >= m.month::timestamp AT TIME ZONE 'UTC' AND at < (m.month + interval '1 month')::timestamp AT TIME ZONE 'UTC'), 0) AS gross,
        COALESCE((SELECT SUM(fee) FROM revenue WHERE at >= m.month::timestamp AT TIME ZONE 'UTC' AND at < (m.month + interval '1 month')::timestamp AT TIME ZONE 'UTC'), 0) AS fee,
        COALESCE((SELECT SUM(trips) FROM revenue WHERE at >= m.month::timestamp AT TIME ZONE 'UTC' AND at < (m.month + interval '1 month')::timestamp AT TIME ZONE 'UTC'), 0) AS trips,
        COALESCE((
          SELECT SUM(r."totalAmount"::numeric)
          FROM driver_monthly_expense_reports r
          WHERE r."driverId" = $1
            AND r."reportingMonth" = to_char(m.month, 'YYYY-MM')
            AND r.status IN ('approved', 'submitted', 'under_review')
        ), 0) AS expenses,
        (
          SELECT r.status
          FROM driver_monthly_expense_reports r
          WHERE r."driverId" = $1
            AND r."reportingMonth" = to_char(m.month, 'YYYY-MM')
          LIMIT 1
        ) AS report_status
      FROM months m ORDER BY m.month
    `,
      [driverId, year, lastMonthIdx + 1],
    )) as Array<{
      month: string;
      gross: string;
      fee: string;
      trips: string;
      expenses: string;
      report_status: string | null;
    }>;
    const monthlyBreakdown = rows.map((row) => {
      const isCurrent = currentMonthStr !== null && row.month === currentMonthStr;
      let status = 'not_submitted';
      if (row.report_status) {
        status = row.report_status;
      } else if (!isCurrent) {
        status = 'not_submitted';
      }

      return {
        month: row.month,
        gross: Number(row.gross),
        serviceFee: Number(row.fee),
        trips: Number(row.trips),
        expenses: Number(row.expenses),
        netTaxable: Number(row.gross) - Number(row.expenses),
        status,
        periodType: isCurrent ? 'current_unsubmitted' : 'ended',
      };
    });
    const grossEarnings = monthlyBreakdown.reduce(
      (sum, row) => sum + row.gross,
      0,
    );
    const reportedExpenses = monthlyBreakdown.reduce(
      (sum, row) => sum + row.expenses,
      0,
    );
    return {
      driverId,
      fiscalYear: year,
      reportPeriod: {
        start,
        end: nextMonthStart,
        basis: isCurrentYear
          ? 'UTC calendar year to date'
          : 'UTC full calendar year',
      },
      totalTrips: monthlyBreakdown.reduce((sum, row) => sum + row.trips, 0),
      grossEarnings,
      reportedExpenses,
      netTaxableEarnings: grossEarnings - reportedExpenses,
      platformFees: monthlyBreakdown.reduce(
        (sum, row) => sum + row.serviceFee,
        0,
      ),
      monthlyBreakdown,
    };
  }

  getDriverExpenses(driverId: string) {
    return this.listDriverMonthlyReports(driverId);
  }

  async getDashboardStats() {
    const yearStart = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
    const startMonth = `${yearStart.getUTCFullYear()}-01`;
    const [
      totalDrivers,
      activeSubscriptions,
      totalTrips,
      totalBookings,
      completedRides,
      fareSum,
      pendingAuditDrivers,
      driversWithExpenses,
      expenseSum,
    ] = await Promise.all([
      this.users
        .createQueryBuilder('u')
        .where(':role = ANY(u.roles)', { role: UserRole.DRIVER })
        .getCount(),
      this.subscriptions.count({ where: { state: SubscriptionState.ACTIVE } }),
      this.trips.count(),
      this.bookings.count({ where: { status: BookingStatus.CONFIRMED } }),
      this.rides.count({ where: { status: RideStatus.COMPLETED } }),
      this.fares
        .createQueryBuilder('f')
        .innerJoin(Ride, 'r', 'r.id = f.rideId')
        .where('r.completedAt >= :yearStart AND r.status = :status', {
          yearStart,
          status: RideStatus.COMPLETED,
        })
        .select('COALESCE(SUM(f.total::numeric), 0)', 'sum')
        .getRawOne<{ sum: string }>(),
      // Not (good standing + approved KYC) — SQL aggregate, not a row dump.
      this.users
        .createQueryBuilder('u')
        .where(':role = ANY(u.roles)', { role: UserRole.DRIVER })
        .andWhere(
          `(u.standing != :good
            OR NOT EXISTS (
              SELECT 1 FROM driver_verifications v
              WHERE v."driverId" = u.id AND v.status = :approved
            ))`,
          { good: AccountStanding.GOOD, approved: VerificationStatus.APPROVED },
        )
        .getCount(),
      this.monthlyReports
        .createQueryBuilder('e')
        .select('COUNT(DISTINCT e."driverId")', 'count')
        .where("e.status IN ('submitted', 'under_review', 'approved')")
        .getRawOne<{ count: string }>(),
      this.monthlyReports
        .createQueryBuilder('e')
        .select('COALESCE(SUM(e."totalAmount"::numeric), 0)', 'total')
        .where('e."reportingMonth" >= :startMonth', { startMonth })
        .andWhere("e.status IN ('submitted', 'under_review', 'approved')")
        .getRawOne<{ total: string }>(),
    ]);

    const withExpenses = Number(driversWithExpenses?.count ?? 0);

    return {
      totalDrivers,
      activeSubscriptions,
      totalTrips: totalTrips + completedRides,
      totalBookings,
      completedOnDemandRides: completedRides,
      grossEarningsYtd: Number(fareSum?.sum ?? 0),
      reportedExpensesYtd: Number(expenseSum?.total ?? 0),
      pendingAuditDrivers,
      driversWithoutExpenses: Math.max(totalDrivers - withExpenses, 0),
      ...(await this.buildNationalMonthlyEarnings()),
    };
  }

  /**
   * Last 12 calendar months of completed on-demand fare totals — powers the
   * government portal national earnings chart from the same Neon/Postgres
   * rides+fares tables the Driver/Rider apps write.
   */
  private async buildNationalMonthlyEarnings(): Promise<{
    monthLabels: string[];
    monthlyEarnings: number[];
  }> {
    const now = new Date();
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1),
    );
    const rows = await this.fares
      .createQueryBuilder('f')
      .innerJoin(Ride, 'r', 'r.id = f.rideId')
      .where('r.status = :status', { status: RideStatus.COMPLETED })
      .andWhere('r.completedAt IS NOT NULL')
      .andWhere('r.completedAt >= :start', { start })
      .select(`to_char(date_trunc('month', r.completedAt), 'YYYY-MM')`, 'month')
      .addSelect('COALESCE(SUM(f.total::numeric), 0)', 'total')
      .groupBy(`date_trunc('month', r.completedAt)`)
      .orderBy(`date_trunc('month', r.completedAt)`, 'ASC')
      .getRawMany<{ month: string; total: string }>();

    const byMonth = new Map(rows.map((r) => [r.month, Number(r.total)]));
    const monthLabels: string[] = [];
    const monthlyEarnings: number[] = [];
    const labelFmt = new Intl.DateTimeFormat('en-US', {
      month: 'short',
      year: '2-digit',
      timeZone: 'UTC',
    });
    for (let i = 11; i >= 0; i -= 1) {
      const d = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1),
      );
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      monthLabels.push(labelFmt.format(d));
      monthlyEarnings.push(byMonth.get(key) ?? 0);
    }
    return { monthLabels, monthlyEarnings };
  }

  // --- Legal request intake ---

  async listLegalRequests(limit = 200) {
    const rows = await this.legalRequests.find({
      order: { receivedAt: 'DESC' },
      take: Math.min(limit, MAX_REPORT_ROWS * 5),
    });
    return this.mapLegalRequests(rows);
  }

  async getLegalRequest(id: string) {
    const row = await this.legalRequests.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Legal request not found');
    const [mapped] = await this.mapLegalRequests([row]);
    const events = await this.legalEvents.find({
      where: { requestId: id },
      order: { occurredAt: 'DESC' },
    });
    return {
      ...mapped,
      events: events.map((e) => ({
        id: e.id,
        action: e.action,
        actorId: e.actorId,
        note: e.note,
        payload: e.payload,
        occurredAt: e.occurredAt.toISOString(),
      })),
    };
  }

  async createLegalRequest(
    officerId: string,
    dto: CreateGovLegalRequestDto,
  ) {
    let driverId = dto.driverId ?? null;
    let driverTin = dto.driverTin?.trim() || null;

    if (driverId) {
      const driver = await this.users.findOne({ where: { id: driverId } });
      if (!driver || !driver.roles?.includes(UserRole.DRIVER)) {
        throw new NotFoundException('Driver not found');
      }
      driverTin = driverTin || driver.tin;
    } else if (driverTin) {
      const byTin = await this.users.findOne({ where: { tin: driverTin } });
      if (byTin) driverId = byTin.id;
    }

    const saved = await this.legalRequests.save(
      this.legalRequests.create({
        type: dto.type as GovLegalRequestType,
        title: dto.title.trim(),
        requestingAuthority: dto.requestingAuthority.trim(),
        caseReference: dto.caseReference.trim(),
        driverId,
        driverTin,
        dataScope: dto.dataScope.map((s) => s.trim()).filter(Boolean),
        priority: (dto.priority ??
          GovLegalRequestPriority.MEDIUM) as GovLegalRequestPriority,
        status: GovLegalRequestStatus.RECEIVED,
        receivedAt: new Date(),
        deadlineAt: dto.deadlineAt ? new Date(dto.deadlineAt) : null,
        assignedOfficerId: null,
        createdByOfficerId: officerId,
        fulfilmentNotes: null,
      }),
    );

    await this.appendLegalEvent(saved.id, officerId, 'created', null, {
      type: saved.type,
      priority: saved.priority,
    });

    const [mapped] = await this.mapLegalRequests([saved]);
    return mapped;
  }

  async updateLegalRequestStatus(
    id: string,
    officerId: string,
    dto: UpdateGovLegalStatusDto,
  ) {
    const row = await this.legalRequests.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Legal request not found');

    const next = dto.status as GovLegalRequestStatus;
    assertLegalStatusTransition(row.status, next);

    const previous = row.status;
    row.status = next;
    if (dto.fulfilmentNotes?.trim()) {
      row.fulfilmentNotes = dto.fulfilmentNotes.trim();
    }
    if (
      next === GovLegalRequestStatus.IN_REVIEW &&
      !row.assignedOfficerId
    ) {
      row.assignedOfficerId = officerId;
    }
    const saved = await this.legalRequests.save(row);

    await this.appendLegalEvent(
      id,
      officerId,
      `status:${next}`,
      dto.note?.trim() || null,
      { from: previous, to: next },
    );

    const [mapped] = await this.mapLegalRequests([saved]);
    return mapped;
  }

  async assignLegalRequest(
    id: string,
    actorId: string,
    dto: AssignGovLegalRequestDto,
  ) {
    const row = await this.legalRequests.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Legal request not found');
    if (!canAssignLegalRequest(row.status)) {
      throw new BadRequestException(
        `Cannot assign a request in status ${row.status}`,
      );
    }

    const officer = await this.users.findOne({ where: { id: dto.officerId } });
    if (!officer || !officer.roles?.includes(UserRole.GOV_OFFICER)) {
      throw new NotFoundException('Officer not found');
    }

    const previous = row.assignedOfficerId;
    row.assignedOfficerId = dto.officerId;
    if (row.status === GovLegalRequestStatus.RECEIVED) {
      row.status = GovLegalRequestStatus.IN_REVIEW;
    }
    const saved = await this.legalRequests.save(row);

    await this.appendLegalEvent(
      id,
      actorId,
      'assigned',
      dto.note?.trim() || null,
      { from: previous, to: dto.officerId },
    );

    const [mapped] = await this.mapLegalRequests([saved]);
    return mapped;
  }

  // --- Persistent report jobs ---

  async listReportJobs(limit = 100) {
    const rows = await this.reportJobs.find({
      order: { createdAt: 'DESC' },
      take: Math.min(limit, 200),
    });
    return this.mapReportJobs(rows);
  }

  async getReportJob(id: string) {
    const row = await this.reportJobs.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Report job not found');
    const [mapped] = await this.mapReportJobs([row]);
    return mapped;
  }

  async downloadReportJob(id: string): Promise<{
    csv: string;
    filename: string;
  }> {
    const row = await this.reportJobs.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Report job not found');
    if (row.status !== GovReportJobStatus.READY || !row.resultCsv) {
      throw new BadRequestException('Report is not ready for download');
    }
    return {
      csv: row.resultCsv,
      filename: `hebir-compliance-${row.tin}-FY${row.fiscalYear}.csv`,
    };
  }

  async createReportJob(officerId: string, dto: CreateGovReportJobDto) {
    const driver = await this.users.findOne({ where: { id: dto.driverId } });
    if (!driver || !driver.roles?.includes(UserRole.DRIVER)) {
      throw new NotFoundException('Driver not found');
    }
    if (!driver.tin) {
      throw new BadRequestException('Driver has no TIN on file');
    }

    const fiscalYear = dto.fiscalYear ?? new Date().getUTCFullYear();
    const format = (dto.format?.trim() || 'CSV').toUpperCase();
    if (format !== 'CSV') {
      throw new BadRequestException('Only CSV format is supported');
    }

    if (dto.legalRequestId) {
      const legal = await this.legalRequests.findOne({
        where: { id: dto.legalRequestId },
      });
      if (!legal) throw new NotFoundException('Legal request not found');
    }

    let job = await this.reportJobs.save(
      this.reportJobs.create({
        requestedByOfficerId: officerId,
        driverId: driver.id,
        tin: driver.tin,
        fiscalYear,
        format,
        status: GovReportJobStatus.PROCESSING,
        parameters: {
          driverName: driver.fullName,
          legalRequestId: dto.legalRequestId ?? null,
        },
        resultCsv: null,
        rowCount: 0,
        grossTotal: null,
        netTaxableTotal: null,
        error: null,
        legalRequestId: dto.legalRequestId ?? null,
        completedAt: null,
      }),
    );

    try {
      const earnings = await this.getDriverEarningsReport(
        driver.id,
        fiscalYear,
      );
      const trips = await this.getAllDriverTripsForYear(driver.id, fiscalYear);
      const officer = await this.users.findOne({ where: { id: officerId } });
      const csv = this.buildComplianceCsv({
        driverName: driver.fullName,
        tin: driver.tin,
        fiscalYear,
        generatedBy: officer?.fullName || officer?.phoneNumber || officerId,
        earnings,
        trips,
      });

      job.status = GovReportJobStatus.READY;
      job.resultCsv = csv;
      job.rowCount = trips.length;
      job.grossTotal = String(earnings.grossEarnings);
      job.netTaxableTotal = String(earnings.netTaxableEarnings);
      job.completedAt = new Date();
      job.error = null;
      job = await this.reportJobs.save(job);
    } catch (err) {
      job.status = GovReportJobStatus.FAILED;
      job.error =
        err instanceof Error ? err.message : 'Report generation failed';
      job.completedAt = new Date();
      job = await this.reportJobs.save(job);
      throw err instanceof BadRequestException ||
        err instanceof NotFoundException
        ? err
        : new BadRequestException(job.error);
    }

    const [mapped] = await this.mapReportJobs([job]);
    return mapped;
  }

  private async getAllDriverTripsForYear(driverId: string, year: number) {
    const start = new Date(Date.UTC(year, 0, 1));
    const end = new Date(Date.UTC(year + 1, 0, 1));
    const rides = await this.rides
      .createQueryBuilder('r')
      .where('r.driverId = :driverId', { driverId })
      .andWhere('r.status = :status', { status: RideStatus.COMPLETED })
      .andWhere('r.completedAt >= :start AND r.completedAt < :end', {
        start,
        end,
      })
      .orderBy('r.completedAt', 'DESC')
      .getMany();
    const filtered = rides;
    const fareByRide =
      filtered.length === 0
        ? []
        : await this.fares.find({
            where: { rideId: In(filtered.map((r) => r.id)) },
          });
    const fareMap = new Map(fareByRide.map((f) => [f.rideId, f]));
    return filtered.map((r) => {
      const fare = fareMap.get(r.id);
      return {
        id: r.id,
        status: r.status,
        pickup: r.pickupAddress,
        dropoff: r.dropoffAddress,
        completedAt: r.completedAt,
        distanceM: r.actualDistanceM ?? r.distanceM,
        durationS: r.actualDurationS ?? r.durationS,
        fareTotal: fare ? Number(fare.total) : 0,
      };
    });
  }

  private buildComplianceCsv(input: {
    driverName: string;
    tin: string;
    fiscalYear: number;
    generatedBy: string;
    earnings: Awaited<ReturnType<GovService['getDriverEarningsReport']>>;
    trips: Array<{
      id: string;
      completedAt: Date | null;
      pickup: string | null;
      dropoff: string | null;
      distanceM: number | null;
      fareTotal: number;
    }>;
  }): string {
    const cell = (value: string | number) => {
      const text = String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const rows: Array<Array<string | number>> = [
      ['Hebir compliance report'],
      ['Driver', input.driverName],
      ['TIN', input.tin],
      ['Calendar year (UTC)', input.fiscalYear],
      ['Generated by', input.generatedBy],
      ['Generated at', new Date().toISOString()],
      [],
      ['Gross earnings (ETB)', input.earnings.grossEarnings],
      ['Reported expenses (ETB)', input.earnings.reportedExpenses],
      ['Net taxable (ETB)', input.earnings.netTaxableEarnings],
      ['Total trips', input.earnings.totalTrips],
      [],
      ['Month', 'Trips', 'Gross', 'Expenses', 'Net taxable'],
      ...input.earnings.monthlyBreakdown.map((m) => [
        m.month,
        m.trips,
        m.gross,
        m.expenses,
        m.netTaxable,
      ]),
      [],
      ['Trip ID', 'Date', 'Route', 'Distance (km)', 'Fare (ETB)'],
      ...input.trips.map((t) => [
        t.id,
        t.completedAt ? t.completedAt.toISOString().slice(0, 10) : '—',
        `${(t.pickup ?? '').trim() || '—'} → ${(t.dropoff ?? '').trim() || '—'}`,
        t.distanceM != null ? (t.distanceM / 1000).toFixed(2) : '0',
        t.fareTotal,
      ]),
    ];
    return rows.map((row) => row.map(cell).join(',')).join('\r\n');
  }

  private async appendLegalEvent(
    requestId: string,
    actorId: string,
    action: string,
    note: string | null,
    payload: Record<string, unknown> | null,
  ) {
    await this.legalEvents.save(
      this.legalEvents.create({
        requestId,
        actorId,
        action,
        note,
        payload,
      }),
    );
  }

  private async mapLegalRequests(rows: GovLegalRequest[]) {
    if (rows.length === 0) return [];
    const driverIds = [
      ...new Set(rows.map((r) => r.driverId).filter(Boolean) as string[]),
    ];
    const officerIds = [
      ...new Set(
        [
          ...rows.map((r) => r.assignedOfficerId),
          ...rows.map((r) => r.createdByOfficerId),
        ].filter(Boolean) as string[],
      ),
    ];
    const people = await this.users.find({
      where: { id: In([...new Set([...driverIds, ...officerIds])]) },
    });
    const byId = new Map(people.map((p) => [p.id, p]));
    const fmt = new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    });

    return rows.map((r) => {
      const driver = r.driverId ? byId.get(r.driverId) : undefined;
      const assignee = r.assignedOfficerId
        ? byId.get(r.assignedOfficerId)
        : undefined;
      return {
        id: r.id,
        type: r.type,
        title: r.title,
        requestingAuthority: r.requestingAuthority,
        caseReference: r.caseReference,
        driverId: r.driverId,
        driverTin: r.driverTin,
        driverName: driver?.fullName || r.driverTin || '—',
        dataScope: r.dataScope ?? [],
        priority: r.priority,
        status: r.status,
        receivedAt: r.receivedAt.toISOString(),
        receivedAtLabel: fmt.format(r.receivedAt),
        deadlineAt: r.deadlineAt?.toISOString() ?? null,
        deadlineLabel: r.deadlineAt ? fmt.format(r.deadlineAt) : '—',
        assignedOfficerId: r.assignedOfficerId,
        assignedOfficer:
          assignee?.fullName || assignee?.phoneNumber || 'Unassigned',
        createdByOfficerId: r.createdByOfficerId,
        fulfilmentNotes: r.fulfilmentNotes,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      };
    });
  }

  private async mapReportJobs(rows: GovReportJob[]) {
    if (rows.length === 0) return [];
    const driverIds = [...new Set(rows.map((r) => r.driverId))];
    const officerIds = [...new Set(rows.map((r) => r.requestedByOfficerId))];
    const people = await this.users.find({
      where: { id: In([...new Set([...driverIds, ...officerIds])]) },
    });
    const byId = new Map(people.map((p) => [p.id, p]));
    const fmt = new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });

    return rows.map((r) => {
      const driver = byId.get(r.driverId);
      const officer = byId.get(r.requestedByOfficerId);
      const driverName =
        (typeof r.parameters?.driverName === 'string'
          ? r.parameters.driverName
          : null) ||
        driver?.fullName ||
        r.driverId;
      return {
        id: r.id,
        driverId: r.driverId,
        driverName,
        tin: r.tin,
        fiscalYear: r.fiscalYear,
        period: `FY ${r.fiscalYear}`,
        format: r.format,
        status: r.status,
        rowCount: r.rowCount,
        grossTotal: r.grossTotal != null ? Number(r.grossTotal) : null,
        netTaxableTotal:
          r.netTaxableTotal != null ? Number(r.netTaxableTotal) : null,
        error: r.error,
        legalRequestId: r.legalRequestId,
        requestedBy: officer?.fullName || officer?.phoneNumber || r.requestedByOfficerId,
        generatedAt: r.createdAt.toISOString(),
        generatedAtLabel: fmt.format(r.createdAt),
        completedAt: r.completedAt?.toISOString() ?? null,
        downloadAvailable: r.status === GovReportJobStatus.READY,
      };
    });
  }
}

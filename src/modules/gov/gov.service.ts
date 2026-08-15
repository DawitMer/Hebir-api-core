import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { GovAccessLog } from './entities/access-log.entity';
import { DriverExpense } from './entities/driver-expense.entity';
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

/** Compliance reports are paged in the portal; this bounds one page. */
const MAX_REPORT_ROWS = 100;
/** Name/TIN search must never dump the fleet — portal shows a hit list. */
const MAX_SEARCH_HITS = 40;

/** Strip LIKE wildcards from user input (safer than ESCAPE with TypeORM). */
function sanitizeSearchTerm(raw: string): string {
  return raw.replace(/[%_\\]/g, '').trim();
}

const EXPENSE_CATEGORY_LABELS: Record<string, string> = {
  fuel: 'Fuel',
  maintenance: 'Maintenance',
  insurance: 'Insurance',
  tolls: 'Tolls & Parking',
  other: 'Other',
};

function normalizeExpenseCategory(raw: string): string {
  const key = raw.trim().toLowerCase();
  if (key === 'tolls & parking') return 'Tolls & Parking';
  return EXPENSE_CATEGORY_LABELS[key] ?? raw.trim();
}

@Injectable()
export class GovService {
  constructor(
    @InjectRepository(GovAccessLog)
    private readonly accessLogs: Repository<GovAccessLog>,
    @InjectRepository(DriverExpense)
    private readonly expenses: Repository<DriverExpense>,
    @InjectRepository(Booking) private readonly bookings: Repository<Booking>,
    @InjectRepository(DriverSubscription)
    private readonly subscriptions: Repository<DriverSubscription>,
    @InjectRepository(Trip) private readonly trips: Repository<Trip>,
    @InjectRepository(RiderRequest)
    private readonly riderRequests: Repository<RiderRequest>,
    @InjectRepository(UserAccount) private readonly users: Repository<UserAccount>,
    @InjectRepository(Vehicle) private readonly vehicles: Repository<Vehicle>,
    @InjectRepository(Ride) private readonly rides: Repository<Ride>,
    @InjectRepository(FareRecord) private readonly fares: Repository<FareRecord>,
    @InjectRepository(DriverVerification)
    private readonly verifications: Repository<DriverVerification>,
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

  async listAccessLogs(limit = 200) {
    const rows = await this.accessLogs.find({
      order: { accessedAt: 'DESC' },
      take: limit,
    });
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

  async listDrivers(filters?: {
    q?: string;
    tin?: string;
    name?: string;
  }) {
    const q = sanitizeSearchTerm(filters?.q ?? '');
    const tin = sanitizeSearchTerm(filters?.tin ?? '');
    const name = sanitizeSearchTerm(filters?.name ?? '');
    const searching = Boolean(q || tin || name);

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
      .take(searching ? MAX_SEARCH_HITS : 0)
      .getMany();

    // Unfiltered list is intentionally empty at fleet scale — use tin/name/q.
    if (!searching) return [];

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
        vehicleType: vehicle
          ? `${vehicle.make} ${vehicle.model}`.trim()
          : '—',
        status:
          d.standing === AccountStanding.GOOD && approvedKyc.has(d.id)
            ? ('compliant' as const)
            : ('pendingAudit' as const),
        fiscalYear: new Date().getFullYear(),
      };
    });
  }

  async listAllExpenses(limit = 300) {
    const rows = await this.expenses.find({
      order: { incurredAt: 'DESC' },
      take: limit,
    });
    const driverIds = [...new Set(rows.map((r) => r.driverId))];
    const owners =
      driverIds.length === 0
        ? []
        : await this.users.find({
            where: { id: In(driverIds) },
            select: { id: true, tin: true, fullName: true },
          });
    const byId = new Map(owners.map((u) => [u.id, u]));
    return rows.map((e) => {
      const owner = byId.get(e.driverId);
      return {
        ...e,
        tin: owner?.tin ?? null,
        driverName: owner?.fullName ?? null,
      };
    });
  }

  async setExpenseReviewStatus(expenseId: string, status: string) {
    const expense = await this.expenses.findOne({ where: { id: expenseId } });
    if (!expense) throw new NotFoundException('Expense not found');
    expense.reviewStatus = status;
    return this.expenses.save(expense);
  }

  /** Driver self-service: declare a business expense for tax compliance. */
  async createDriverExpense(input: {
    driverId: string;
    category: string;
    amount: number;
    description: string | null;
    incurredAt?: Date;
  }) {
    const category = normalizeExpenseCategory(input.category);
    const row = this.expenses.create({
      driverId: input.driverId,
      category,
      amount: input.amount.toFixed(2),
      description: input.description,
      incurredAt: input.incurredAt ?? new Date(),
      reviewStatus: 'pending',
    });
    return this.expenses.save(row);
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
      trips: rides.map((r) => {
        const fare = fareMap.get(r.id);
        return {
          id: r.id,
          status: r.status,
          pickup: r.pickupAddress,
          dropoff: r.dropoffAddress,
          completedAt: r.completedAt,
          distanceM: r.distanceM,
          durationS: r.durationS,
          fareTotal: fare ? Number(fare.total) : 0,
        };
      }),
    };
  }

  async getDriverEarningsReport(driverId: string) {
    const driver = await this.users.findOne({ where: { id: driverId } });
    if (!driver) throw new NotFoundException('Driver not found');

    const confirmedBookings = await this.bookings
      .createQueryBuilder('booking')
      .innerJoin('trips', 'trip', 'trip.id = booking.tripId')
      .where('trip.driverId = :driverId', { driverId })
      .andWhere('booking.status = :status', {
        status: BookingStatus.CONFIRMED,
      })
      .select([
        'booking.calculatedFare AS "calculatedFare"',
        'booking.createdAt AS "createdAt"',
      ])
      .getRawMany<{ calculatedFare: string; createdAt: Date }>();

    const bookingGross = confirmedBookings.reduce(
      (sum, b) => sum + Number(b.calculatedFare),
      0,
    );

    const completedRides = await this.rides.find({
      where: { driverId, status: RideStatus.COMPLETED },
      order: { completedAt: 'DESC' },
      take: MAX_REPORT_ROWS,
    });
    const fareRows =
      completedRides.length === 0
        ? []
        : await this.fares.find({
            where: { rideId: In(completedRides.map((r) => r.id)) },
          });
    const rideGross = fareRows.reduce((sum, f) => sum + Number(f.total), 0);
    // Zero under the current subscription-only business model, but computed
    // from fare records so it stays truthful if the model ever changes.
    const platformFees = fareRows.reduce(
      (sum, f) => sum + Number(f.platformFee),
      0,
    );

    const driverExpenses = await this.expenses.find({
      where: { driverId },
      order: { incurredAt: 'DESC' },
      take: MAX_REPORT_ROWS,
    });
    const reportedExpenses = driverExpenses.reduce(
      (sum, e) => sum + Number(e.amount),
      0,
    );

    const grossEarnings = bookingGross + rideGross;
    const totalTrips = confirmedBookings.length + completedRides.length;

    return {
      driverId,
      totalTrips,
      grossEarnings,
      reportedExpenses,
      netTaxableEarnings: grossEarnings - reportedExpenses,
      platformFees,
    };
  }

  getDriverExpenses(driverId: string) {
    return this.expenses.find({
      where: { driverId },
      order: { incurredAt: 'DESC' },
      take: MAX_REPORT_ROWS,
    });
  }

  async getDashboardStats() {
    const [
      totalDrivers,
      activeSubscriptions,
      totalTrips,
      totalBookings,
      completedRides,
      fareSum,
      pendingAuditDrivers,
      driversWithExpenses,
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
      this.expenses
        .createQueryBuilder('e')
        .select('COUNT(DISTINCT e.driverId)', 'count')
        .getRawOne<{ count: string }>(),
    ]);

    const withExpenses = Number(driversWithExpenses?.count ?? 0);

    return {
      totalDrivers,
      activeSubscriptions,
      totalTrips: totalTrips + completedRides,
      totalBookings,
      completedOnDemandRides: completedRides,
      grossEarningsYtd: Number(fareSum?.sum ?? 0),
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
}

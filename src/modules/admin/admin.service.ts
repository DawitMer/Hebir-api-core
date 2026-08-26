import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, In, Repository } from 'typeorm';
import {
  AccountStanding,
  UserAccount,
  UserRole,
} from '../auth/entities/user-account.entity';
import {
  DriverProfile,
  DriverStatus,
} from '../rides/entities/driver-profile.entity';
import { Vehicle } from '../rides/entities/vehicle.entity';
import { Ride, RideStatus } from '../rides/entities/ride.entity';
import {
  DriverVerification,
  VerificationStatus,
} from '../kyc/entities/driver-verification.entity';
import { AuditTrail } from '../kyc/entities/audit-trail.entity';
import { FareRecord } from '../rides/entities/fare-record.entity';
import { DriverExpense } from '../gov/entities/driver-expense.entity';
import { DriverLocationHistory } from '../location/entities/driver-location-history.entity';
import { IncidentsService } from '../incidents/incidents.service';
import { LocationSvcClient } from '../../common/location-svc/location-svc.client';

/** Ops lists are bounded so a growing fleet cannot OOM a dashboard call. */
const MAX_LIST_ROWS = 500;

/** Cap map pins returned to Ops — viewport clustering belongs in the UI at 10k+. */
const LIVE_MAP_PIN_LIMIT = 250;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly locationSvc: LocationSvcClient,
    @InjectRepository(UserAccount)
    private readonly users: Repository<UserAccount>,
    @InjectRepository(DriverProfile)
    private readonly driverProfiles: Repository<DriverProfile>,
    @InjectRepository(Vehicle) private readonly vehicles: Repository<Vehicle>,
    @InjectRepository(Ride) private readonly rides: Repository<Ride>,
    @InjectRepository(DriverVerification)
    private readonly verifications: Repository<DriverVerification>,
    @InjectRepository(AuditTrail)
    private readonly audit: Repository<AuditTrail>,
    @InjectRepository(FareRecord)
    private readonly fares: Repository<FareRecord>,
    @InjectRepository(DriverExpense)
    private readonly expenses: Repository<DriverExpense>,
    @InjectRepository(DriverLocationHistory)
    private readonly locationHistory: Repository<DriverLocationHistory>,
    private readonly incidents: IncidentsService,
  ) {}

  async listUsers(role?: string) {
    const qb = this.users
      .createQueryBuilder('u')
      .orderBy('u.createdAt', 'DESC')
      .take(MAX_LIST_ROWS);
    if (role) {
      qb.where(':role = ANY(u.roles)', { role });
    }
    const users = await qb.getMany();
    return users.map((u) => this.toUserRow(u));
  }

  /** Recent drivers only — never the full fleet. Prefer /admin/search?q= for lookup. */
  async listDrivers(limit = 50) {
    const take = Math.min(Math.max(Number(limit) || 50, 1), MAX_LIST_ROWS);
    const drivers = await this.users
      .createQueryBuilder('u')
      .where(':role = ANY(u.roles)', { role: UserRole.DRIVER })
      .orderBy('u.createdAt', 'DESC')
      .take(take)
      .getMany();
    return this.enrichDriversBatch(drivers);
  }

  async getDriver(id: string) {
    const user = await this.users.findOne({ where: { id } });
    if (!user || !user.roles?.includes(UserRole.DRIVER)) {
      throw new NotFoundException('Driver not found');
    }
    return this.enrichDriver(user);
  }

  async setDriverSuspended(
    id: string,
    suspended: boolean,
    actorId: string,
    actorRole: string,
    reason?: string,
  ) {
    const user = await this.users.findOne({ where: { id } });
    if (!user) throw new NotFoundException('Driver not found');
    user.standing = suspended ? AccountStanding.BANNED : AccountStanding.GOOD;
    await this.users.save(user);
    await this.audit.save(
      this.audit.create({
        actorId,
        actorRole,
        action: suspended ? 'driver.suspend' : 'driver.unsuspend',
        targetType: 'driver',
        targetId: id,
        metadata: { reason: reason ?? null },
      }),
    );
    return this.enrichDriver(user);
  }

  async listApplications(status?: string) {
    const where = status ? { status: status as VerificationStatus } : {};
    const rows = await this.verifications.find({
      where,
      order: { submittedAt: 'ASC' },
      take: 200,
    });
    return this.enrichApplicationsBatch(rows);
  }

  async getApplication(id: string) {
    const v = await this.verifications.findOne({ where: { id } });
    if (!v) throw new NotFoundException('Application not found');
    const [row] = await this.enrichApplicationsBatch([v]);
    return row;
  }

  async search(q: string) {
    const query = q.trim();
    // Empty query must not dump recent users — portals type-to-search only.
    if (query.length < 2) {
      return [];
    }
    const users = await this.users.find({
      where: [
        { fullName: ILike(`%${query}%`) },
        { username: ILike(`%${query}%`) },
        { phoneNumber: ILike(`%${query}%`) },
        { tin: ILike(`${query}%`) },
        { tin: ILike(`%${query}%`) },
      ],
      take: 40,
    });

    const apps = await this.verifications.find({
      where: [
        { licenseNumber: ILike(`%${query}%`) },
        { region: ILike(`%${query}%`) },
      ],
      take: 20,
    });

    const rides = await this.rides.find({
      where: [
        { pickupAddress: ILike(`%${query}%`) },
        { dropoffAddress: ILike(`%${query}%`) },
      ],
      take: 20,
      order: { createdAt: 'DESC' },
    });

    return [
      ...users.map((u) => ({
        id: u.id,
        title: u.fullName || u.phoneNumber,
        referenceId: u.tin || u.phoneNumber,
        location: u.username ? `@${u.username}` : '—',
        status: u.standing,
        category: u.roles?.includes(UserRole.DRIVER)
          ? 'drivers'
          : 'applications',
        linkedProfileId: u.id,
        searchTerms: [u.fullName, u.username, u.phoneNumber, u.tin].filter(
          Boolean,
        ),
      })),
      ...apps.map((a) => ({
        id: a.id,
        title: `KYC ${a.licenseNumber}`,
        referenceId: a.id.slice(0, 8).toUpperCase(),
        location: a.region,
        status: a.status,
        category: 'applications' as const,
        linkedProfileId: a.driverId,
        searchTerms: [a.licenseNumber, a.region, a.vehicleType],
      })),
      ...rides.map((r) => ({
        id: r.id,
        title: r.dropoffAddress || r.pickupAddress || 'Ride',
        referenceId: r.id.slice(0, 8).toUpperCase(),
        location: r.pickupAddress || 'Addis Ababa',
        status: r.status,
        category: 'trips' as const,
        linkedProfileId: r.driverId ?? r.riderId,
        searchTerms: [r.pickupAddress, r.dropoffAddress, r.status].filter(
          Boolean,
        ),
      })),
    ];
  }

  async getLiveOperations() {
    const center = { lat: 8.9806, lng: 38.7578 };

    // Aggregate metrics — never load all driver_profiles rows at 10k scale.
    const statusRows = await this.driverProfiles
      .createQueryBuilder('p')
      .select('p.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('p.status')
      .getRawMany<{ status: string; count: string }>();
    const byStatus = Object.fromEntries(
      statusRows.map((r) => [r.status, Number(r.count)]),
    );
    const online = byStatus[DriverStatus.ONLINE] ?? 0;
    const onTrip = byStatus[DriverStatus.ON_TRIP] ?? 0;
    const offline = byStatus[DriverStatus.OFFLINE] ?? 0;
    const reserved = byStatus[DriverStatus.RESERVED] ?? 0;

    const activeRides = await this.rides.find({
      where: {
        status: In([
          RideStatus.SEARCHING,
          RideStatus.OFFERED,
          RideStatus.MATCHED,
          RideStatus.ACCEPTED,
          RideStatus.ARRIVING,
          RideStatus.IN_PROGRESS,
        ]),
      },
      order: { updatedAt: 'DESC' },
      take: 50,
    });

    // Pins come from Redis geo (already radius-capped), not from full profile scan.
    // Ignore non-UUID geo members (load-test / synthetic IDs).
    const liveCoords = await this.fetchLiveDriverCoords(center);
    let pinIds = [...liveCoords.keys()]
      .filter((id) => UUID_RE.test(id))
      .slice(0, LIVE_MAP_PIN_LIMIT);

    // When location-svc is down / empty, build pins from active Postgres profiles
    // so Live Ops does not go dark while metrics still show online drivers.
    if (pinIds.length === 0) {
      const activeProfiles = await this.driverProfiles.find({
        where: {
          status: In([
            DriverStatus.ONLINE,
            DriverStatus.RESERVED,
            DriverStatus.ON_TRIP,
          ]),
        },
        take: LIVE_MAP_PIN_LIMIT,
      });
      pinIds = activeProfiles
        .map((p) => p.userId)
        .filter((id) => UUID_RE.test(id));
    }

    const [users, profiles] = pinIds.length
      ? await Promise.all([
          this.users.find({ where: { id: In(pinIds) } }),
          this.driverProfiles.find({ where: { userId: In(pinIds) } }),
        ])
      : [[], []];
    const byId = new Map(users.map((d) => [d.id, d]));
    const profileByUser = new Map(profiles.map((p) => [p.userId, p]));

    const missingLive = pinIds.filter((id) => !liveCoords.has(id));
    const historyCoords = await this.fetchLatestHistoryCoords(missingLive);

    // A driver with no live or history coordinates gets NO pin — a map pin
    // at a made-up location is worse than a missing one.
    const driverPins = pinIds.flatMap((driverId) => {
      const user = byId.get(driverId);
      const profile = profileByUser.get(driverId);
      const coords = liveCoords.get(driverId) ?? historyCoords.get(driverId);
      if (!coords) return [];
      const { lat, lng } = coords;
      const status =
        profile?.status === DriverStatus.ON_TRIP
          ? 'on_trip'
          : profile?.status === DriverStatus.ONLINE || !profile
            ? 'available'
            : 'idle';
      return [
        {
          driverId,
          label: user?.fullName || user?.phoneNumber || driverId.slice(0, 8),
          status,
          lat,
          lng,
          x: 0.5 + (lng - center.lng) / 0.16,
          y: 0.5 - (lat - center.lat) / 0.14,
        },
      ];
    });

    const demandCells = await this.fetchDemandCells(center);

    const sosRows = await this.incidents.listOpenSos(12);
    const sosAlerts = sosRows.map((inc) => ({
      id: inc.caseNumber,
      type: 'emergency' as const,
      title: inc.title,
      timeLabel: new Date(inc.reportedAt).toLocaleTimeString(),
      body: inc.description,
      lat: inc.lat ?? undefined,
      lng: inc.lng ?? undefined,
      actionLabel: 'Open incident case →',
      isNew: inc.status === 'open',
    }));

    const rideAlerts = activeRides.slice(0, 8).map((r) => {
      const pickup = r.pickup as { lat?: number; lng?: number } | null;
      return {
        id: r.id,
        type: r.status === RideStatus.SEARCHING ? 'info' : 'warning',
        title: `Ride ${r.status}`,
        timeLabel: new Date(r.updatedAt).toLocaleTimeString(),
        body: `${r.pickupAddress ?? 'Pickup'} → ${r.dropoffAddress ?? 'Dropoff'}`,
        lat: pickup?.lat,
        lng: pickup?.lng,
        isNew: true,
      };
    });

    const alerts = [...sosAlerts, ...rideAlerts].slice(0, 16);

    return {
      metrics: {
        onlineDrivers: online + reserved,
        onTrip,
        offline,
      },
      mapCenter: { lat: center.lat, lng: center.lng, zoom: 12 },
      driverPins,
      alerts,
      activeRides: activeRides.map((r) => ({
        id: r.id,
        status: r.status,
        riderId: r.riderId,
        driverId: r.driverId,
        pickupAddress: r.pickupAddress,
        dropoffAddress: r.dropoffAddress,
        updatedAt: r.updatedAt,
      })),
      demandCells,
      source: {
        redisPins: liveCoords.size,
        historyPins: historyCoords.size,
        demandCells: demandCells.length,
        pinLimit: LIVE_MAP_PIN_LIMIT,
      },
    };
  }

  private async fetchLiveDriverCoords(center: { lat: number; lng: number }) {
    const out = new Map<string, { lat: number; lng: number }>();
    if (!this.locationSvc.enabled || this.locationSvc.isOpen) return out;
    try {
      const data = await this.locationSvc.get<{
        drivers?: Array<{ driverId: string; lat: number; lng: number }>;
      }>(
        '/drivers/locations',
        {
          lat: center.lat,
          lng: center.lng,
          radiusKm: 30,
          limit: LIVE_MAP_PIN_LIMIT,
        },
        2500,
      );
      for (const d of data?.drivers ?? []) {
        if (d?.driverId && Number.isFinite(d.lat) && Number.isFinite(d.lng)) {
          out.set(d.driverId, { lat: d.lat, lng: d.lng });
        }
      }
    } catch (error) {
      this.logger.warn(
        `Live driver coords unavailable: ${(error as Error).message}`,
      );
    }
    return out;
  }

  private async fetchLatestHistoryCoords(driverIds: string[]) {
    const out = new Map<string, { lat: number; lng: number }>();
    if (!driverIds.length) return out;
    try {
      const rows = await this.locationHistory
        .createQueryBuilder('h')
        .distinctOn(['h.driverId'])
        .where('h.driverId IN (:...driverIds)', { driverIds })
        .orderBy('h.driverId')
        .addOrderBy('h.recordedAt', 'DESC')
        .getMany();
      for (const row of rows) {
        out.set(row.driverId, { lat: row.lat, lng: row.lng });
      }
    } catch (error) {
      this.logger.warn(
        `History coords unavailable: ${(error as Error).message}`,
      );
    }
    return out;
  }

  private async fetchDemandCells(center: { lat: number; lng: number }) {
    if (!this.locationSvc.enabled || this.locationSvc.isOpen) return [];
    const pad = 0.12;
    try {
      const data = await this.locationSvc.get<{
        cells?: Array<{
          zoneId: string;
          lat: number;
          lng: number;
          demandRatio: number;
          riders?: number;
          drivers?: number;
        }>;
      }>(
        '/demand/grid',
        {
          minLat: center.lat - pad,
          minLng: center.lng - pad,
          maxLat: center.lat + pad,
          maxLng: center.lng + pad,
        },
        2500,
      );
      return data?.cells ?? [];
    } catch (error) {
      this.logger.warn(`Demand grid unavailable: ${(error as Error).message}`);
      return [];
    }
  }

  async bootstrapDemo() {
    const drivers = await this.users
      .createQueryBuilder('u')
      .where(':role = ANY(u.roles)', { role: UserRole.DRIVER })
      .take(MAX_LIST_ROWS)
      .getMany();

    let kycCreated = 0;
    let expensesCreated = 0;

    for (const driver of drivers.slice(0, 6)) {
      const existing = await this.verifications.findOne({
        where: { driverId: driver.id },
      });
      if (!existing) {
        const vehicle = await this.vehicles.findOne({
          where: { driverId: driver.id },
        });
        await this.verifications.save(
          this.verifications.create({
            driverId: driver.id,
            licenseNumber: `ET-${driver.phoneNumber.replace(/\D/g, '').slice(-6)}`,
            region: 'Addis Ababa',
            vehicleType: vehicle?.make ?? 'Sedan',
            vehicleYear: 2019,
            status: VerificationStatus.PENDING,
          }),
        );
        kycCreated += 1;
      }

      const expenseCount = await this.expenses.count({
        where: { driverId: driver.id },
      });
      if (expenseCount === 0) {
        await this.expenses.save([
          this.expenses.create({
            driverId: driver.id,
            category: 'Fuel',
            amount: '850.00',
            description: 'Weekly fuel',
            incurredAt: new Date(Date.now() - 3 * 86400000),
          }),
          this.expenses.create({
            driverId: driver.id,
            category: 'Maintenance',
            amount: '1200.00',
            description: 'Oil change',
            incurredAt: new Date(Date.now() - 10 * 86400000),
          }),
        ]);
        expensesCreated += 2;
      }
    }

    return {
      drivers: drivers.length,
      kycCreated,
      expensesCreated,
    };
  }

  private async enrichDriversBatch(users: UserAccount[]) {
    if (users.length === 0) return [];
    const ids = users.map((u) => u.id);
    const [profiles, vehicles, approvedKyc, fareGross] = await Promise.all([
      this.driverProfiles.find({ where: { userId: In(ids) } }),
      this.vehicles.find({ where: { driverId: In(ids) } }),
      this.verifications.find({
        where: {
          driverId: In(ids),
          status: VerificationStatus.APPROVED,
        },
        select: { driverId: true },
      }),
      this.fares
        .createQueryBuilder('f')
        .innerJoin(Ride, 'r', 'r.id = f.rideId')
        .select('r.driverId', 'driverId')
        .addSelect('COALESCE(SUM(f.total::numeric), 0)', 'gross')
        .where('r.driverId IN (:...ids)', { ids })
        .andWhere('r.status = :status', { status: RideStatus.COMPLETED })
        .groupBy('r.driverId')
        .getRawMany<{ driverId: string; gross: string }>(),
    ]);

    const profileBy = new Map(profiles.map((p) => [p.userId, p]));
    const vehicleBy = new Map(vehicles.map((v) => [v.driverId, v]));
    const approved = new Set(approvedKyc.map((v) => v.driverId));
    const grossBy = new Map(
      fareGross.map((row) => [row.driverId, Number(row.gross)]),
    );

    return users.map((user) => {
      const profile = profileBy.get(user.id);
      const vehicle = vehicleBy.get(user.id);
      return {
        id: user.id,
        fullName: user.fullName,
        username: user.username,
        phoneNumber: user.phoneNumber,
        standing: user.standing,
        status: profile?.status ?? DriverStatus.OFFLINE,
        rating: Number(profile?.ratingAvg ?? 0),
        tripCount: profile?.totalTrips ?? 0,
        grossEarnings: grossBy.get(user.id) ?? 0,
        vehicle: vehicle
          ? {
              make: vehicle.make,
              model: vehicle.model,
              makeModel: `${vehicle.make} ${vehicle.model}`.trim(),
              plate: vehicle.plate,
              color: vehicle.color,
              capacity: vehicle.capacity,
            }
          : null,
        createdAt: user.createdAt,
        tin: user.tin ?? null,
        vehicleType: vehicle ? `${vehicle.make} ${vehicle.model}` : '—',
        fiscalYear: new Date().getFullYear(),
        complianceStatus:
          user.standing === AccountStanding.GOOD && approved.has(user.id)
            ? ('compliant' as const)
            : ('pendingAudit' as const),
      };
    });
  }

  private async enrichDriver(user: UserAccount) {
    const [row] = await this.enrichDriversBatch([user]);
    return row;
  }

  /** Batch user lookups so the KYC queue cannot N+1 `user_accounts`. */
  private async enrichApplicationsBatch(rows: DriverVerification[]) {
    if (!rows.length) return [];
    const driverIds = [...new Set(rows.map((v) => v.driverId))];
    const drivers = await this.users.find({ where: { id: In(driverIds) } });
    const byId = new Map(drivers.map((d) => [d.id, d]));
    return rows.map((v) => this.toApplicationRow(v, byId.get(v.driverId)));
  }

  private toApplicationRow(v: DriverVerification, driver?: UserAccount) {
    return {
      id: v.id,
      driverId: v.driverId,
      driverName: driver?.fullName || driver?.phoneNumber || v.driverId,
      phoneNumber: driver?.phoneNumber ?? '',
      licenseNumber: v.licenseNumber,
      region: v.region,
      status: v.status,
      queueStatus: v.status,
      submittedAt: v.submittedAt,
      vehicleType: v.vehicleType,
      vehicleYear: v.vehicleYear,
      assignedToName: v.assignedToId,
      applicationRef: `APP-${v.id.slice(0, 8).toUpperCase()}`,
      missingId: v.missingId,
      missingInsurance: v.missingInsurance,
      rejectionReason: v.rejectionReason,
    };
  }

  private toUserRow(u: UserAccount) {
    return {
      id: u.id,
      phoneNumber: u.phoneNumber,
      fullName: u.fullName,
      username: u.username,
      roles: u.roles,
      standing: u.standing,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
    };
  }
}

import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Inject } from '@nestjs/common';
import { Repository } from 'typeorm';
import Redis from 'ioredis';
import {
  Incident,
  IncidentPriority,
  IncidentStatus,
  IncidentType,
} from './entities/incident.entity';
import {
  CreateIncidentDto,
  CreateSosDto,
  UpdateIncidentStatusDto,
} from './dto/incident.dto';
import { UserAccount } from '../auth/entities/user-account.entity';
import { Ride } from '../rides/entities/ride.entity';
import { NotificationsGateway } from '../notifications/notifications.gateway';
import { REDIS_CLIENT } from '../../redis/redis.module';

@Injectable()
export class IncidentsService {
  private readonly logger = new Logger(IncidentsService.name);

  constructor(
    @InjectRepository(Incident)
    private readonly incidents: Repository<Incident>,
    @InjectRepository(UserAccount)
    private readonly users: Repository<UserAccount>,
    @InjectRepository(Ride) private readonly rides: Repository<Ride>,
    private readonly notifications: NotificationsGateway,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async createSos(reporterId: string, reporterRole: string, dto: CreateSosDto) {
    const reporter = await this.users.findOne({ where: { id: reporterId } });
    // Only a participant may attach a ride, otherwise anyone could file an
    // incident against someone else's trip and pull it into the ops queue.
    const ride = await this.participantRide(dto.rideId, reporterId);

    const counterpartId =
      ride == null
        ? null
        : ride.riderId === reporterId
          ? ride.driverId
          : ride.driverId === reporterId
            ? ride.riderId
            : null;

    const counterpart = counterpartId
      ? await this.users.findOne({ where: { id: counterpartId } })
      : null;

    const caseNumber = await this.nextCaseNumber();
    const who = reporterRole === 'driver' ? 'Driver' : 'Rider';
    const title = 'Emergency button pressed';
    const description =
      dto.note?.trim() ||
      `${who} pressed SOS` +
        (dto.locationLabel ? ` near ${dto.locationLabel}` : '') +
        (ride ? ` during ride ${ride.id.slice(0, 8)}` : '') +
        '.';

    const incident = await this.incidents.save(
      this.incidents.create({
        caseNumber,
        type: IncidentType.SOS,
        title,
        description,
        priority: IncidentPriority.CRITICAL,
        status: IncidentStatus.OPEN,
        reporterId,
        reporterRole,
        rideId: ride?.id ?? null,
        relatedUserId: counterpartId,
        relatedName:
          counterpart?.fullName ||
          counterpart?.phoneNumber ||
          (ride ? `Trip ${ride.id.slice(0, 8)}` : reporter?.fullName) ||
          who,
        lat: dto.lat ?? null,
        lng: dto.lng ?? null,
        locationLabel: dto.locationLabel ?? null,
      }),
    );

    await this.notifications.notify(reporterId, 'incident.sos_ack', {
      caseNumber: incident.caseNumber,
      id: incident.id,
    });

    if (counterpartId) {
      await this.notifications.notify(counterpartId, 'incident.sos_peer', {
        caseNumber: incident.caseNumber,
        rideId: ride?.id,
      });
    }

    this.logger.warn(
      `SOS ${incident.caseNumber} from ${reporterRole} ${reporterId}` +
        (ride ? ` ride=${ride.id}` : ''),
    );

    return this.toListItem(incident);
  }

  async createReport(
    reporterId: string,
    reporterRole: string,
    dto: CreateIncidentDto,
  ) {
    const ride = await this.participantRide(dto.rideId, reporterId);
    const caseNumber = await this.nextCaseNumber();
    const incident = await this.incidents.save(
      this.incidents.create({
        caseNumber,
        type: dto.type,
        title: dto.title,
        description: dto.description,
        priority: dto.priority ?? IncidentPriority.MEDIUM,
        status: IncidentStatus.OPEN,
        reporterId,
        reporterRole,
        rideId: ride?.id ?? null,
        relatedUserId: null,
        relatedName: ride ? `Trip ${ride.id.slice(0, 8)}` : null,
        lat: dto.lat ?? null,
        lng: dto.lng ?? null,
        locationLabel: dto.locationLabel ?? null,
      }),
    );
    return this.toListItem(incident);
  }

  /** Resolves an optional rideId, but only when the reporter was on that ride. */
  private async participantRide(
    rideId: string | undefined,
    reporterId: string,
  ): Promise<Ride | null> {
    if (!rideId) return null;
    const ride = await this.rides.findOne({ where: { id: rideId } });
    if (!ride) throw new NotFoundException('Ride not found');
    if (ride.riderId !== reporterId && ride.driverId !== reporterId) {
      throw new ForbiddenException('You are not a participant on this ride');
    }
    return ride;
  }

  async list(status?: IncidentStatus) {
    const where = status ? { status } : {};
    const rows = await this.incidents.find({
      where,
      order: { reportedAt: 'DESC' },
      take: 200,
    });
    return rows.map((r) => this.toListItem(r));
  }

  async listOpenSos(limit = 20) {
    return this.incidents.find({
      where: [
        { type: IncidentType.SOS, status: IncidentStatus.OPEN },
        { type: IncidentType.SOS, status: IncidentStatus.ASSIGNED },
        { type: IncidentType.SAFETY_ALERT, status: IncidentStatus.OPEN },
      ],
      order: { reportedAt: 'DESC' },
      take: limit,
    });
  }

  async getByCaseNumber(caseNumber: string) {
    const incident = await this.incidents.findOne({ where: { caseNumber } });
    if (!incident) throw new NotFoundException('Incident not found');

    const reporter = await this.users.findOne({
      where: { id: incident.reporterId },
    });
    const related = incident.relatedUserId
      ? await this.users.findOne({ where: { id: incident.relatedUserId } })
      : null;
    const ride = incident.rideId
      ? await this.rides.findOne({ where: { id: incident.rideId } })
      : null;

    return {
      caseNumber: incident.caseNumber,
      statusLabel: incident.status,
      categoryLabel: incident.type,
      driver: {
        name:
          related?.fullName ||
          reporter?.fullName ||
          incident.relatedName ||
          'Unknown',
        driverId: related?.id || reporter?.id || incident.reporterId,
        rating: 0,
        tripCountLabel: ride ? 'Linked trip' : 'No trip linked',
        phoneNumber: related?.phoneNumber || reporter?.phoneNumber || '—',
        linkedProfileId: related?.id ?? reporter?.id ?? null,
      },
      initialReportBody: incident.description,
      initialReportDateLabel: incident.reportedAt.toISOString(),
      attachments: [],
      messages: [
        {
          id: `${incident.id}-0`,
          senderLabel: 'System',
          isAgent: false,
          body: incident.description,
          timestampLabel: incident.reportedAt.toLocaleString(),
        },
      ],
      trip: ride
        ? {
            tripId: ride.id,
            fareLabel: '—',
            distanceLabel: ride.distanceM
              ? `${(ride.distanceM / 1000).toFixed(1)} km`
              : '—',
            durationLabel: ride.durationS
              ? `${Math.round(ride.durationS / 60)} min`
              : '—',
          }
        : undefined,
      list: this.toListItem(incident),
    };
  }

  async updateStatus(
    caseNumber: string,
    dto: UpdateIncidentStatusDto,
    actorId: string,
    actorName?: string,
  ) {
    const incident = await this.incidents.findOne({ where: { caseNumber } });
    if (!incident) throw new NotFoundException('Incident not found');

    incident.status = dto.status;
    if (dto.status === IncidentStatus.ASSIGNED) {
      incident.assignedToId = actorId;
      incident.assignedToName = dto.assignedToName || actorName || 'Ops agent';
      incident.assignedAt = new Date();
      incident.resolvedAt = null;
    } else if (dto.status === IncidentStatus.RESOLVED) {
      incident.resolvedAt = new Date();
    } else if (dto.status === IncidentStatus.OPEN) {
      incident.assignedToId = null;
      incident.assignedToName = null;
      incident.assignedAt = null;
      incident.resolvedAt = null;
    }

    await this.incidents.save(incident);

    await this.notifications.notify(incident.reporterId, 'incident.status', {
      caseNumber: incident.caseNumber,
      status: incident.status,
    });

    return this.toListItem(incident);
  }

  private async nextCaseNumber() {
    const year = new Date().getFullYear();
    const seq = await this.redis.incr(`incident:seq:${year}`);
    return `OPS-${year}-${String(seq).padStart(5, '0')}`;
  }

  private toListItem(incident: Incident) {
    return {
      caseNumber: incident.caseNumber,
      type: incident.type,
      title: incident.title,
      description: incident.description,
      priority: incident.priority,
      relatedId:
        incident.rideId || incident.relatedUserId || incident.reporterId,
      relatedName: incident.relatedName || incident.caseNumber,
      reportedAt: incident.reportedAt.toISOString(),
      status: incident.status,
      assignedToName: incident.assignedToName ?? undefined,
      assignedToId: incident.assignedToId ?? undefined,
      assignedAt: incident.assignedAt?.toISOString(),
      lat: incident.lat ?? undefined,
      lng: incident.lng ?? undefined,
      locationLabel: incident.locationLabel ?? undefined,
      rideId: incident.rideId ?? undefined,
      reporterId: incident.reporterId,
      reporterRole: incident.reporterRole,
    };
  }
}

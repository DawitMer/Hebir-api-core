import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GovService } from './gov.service';
import {
  GovLegalRequestPriority,
  GovLegalRequestStatus,
  GovLegalRequestType,
} from './entities/gov-legal-request.entity';
import { GovReportJobStatus } from './entities/gov-report-job.entity';
import { UserRole } from '../auth/entities/user-account.entity';

function repo<T extends { id?: string }>(seed: T[] = []) {
  const rows: T[] = [...seed];
  let n = 0;
  return {
    rows,
    findOne: jest.fn(
      async ({ where }: { where: Partial<T> }) =>
        rows.find((r) =>
          Object.entries(where).every(([k, v]) => (r as any)[k] === v),
        ) ?? null,
    ),
    find: jest.fn(async (opts?: { order?: unknown; take?: number }) => {
      const out = [...rows];
      return opts?.take != null ? out.slice(0, opts.take) : out;
    }),
    create: jest.fn((v: T) => ({ ...v })),
    save: jest.fn(async (v: T) => {
      const saved = {
        ...v,
        id: v.id ?? `id-${++n}`,
        createdAt: (v as any).createdAt ?? new Date('2026-01-15T00:00:00Z'),
        updatedAt: new Date('2026-01-15T00:00:00Z'),
        receivedAt: (v as any).receivedAt ?? new Date('2026-01-15T00:00:00Z'),
      } as T;
      const idx = rows.findIndex((r) => r.id === saved.id);
      if (idx >= 0) rows[idx] = saved;
      else rows.push(saved);
      return saved;
    }),
  };
}

function build(seed?: {
  legal?: any[];
  users?: any[];
  events?: any[];
  reports?: any[];
}) {
  const accessLogs = repo();
  const monthlyReports = repo();
  const legalRequests = repo(seed?.legal ?? []);
  const legalEvents = repo(seed?.events ?? []);
  const reportJobs = repo(seed?.reports ?? []);
  const bookings = repo();
  const subscriptions = repo();
  const trips = repo();
  const riderRequests = repo();
  const users = repo(
    seed?.users ?? [
      {
        id: 'officer-1',
        fullName: 'Officer One',
        phoneNumber: '0911000001',
        roles: [UserRole.GOV_OFFICER],
        tin: null,
      },
      {
        id: 'officer-2',
        fullName: 'Officer Two',
        phoneNumber: '0911000002',
        roles: [UserRole.GOV_OFFICER],
        tin: null,
      },
      {
        id: 'driver-1',
        fullName: 'Driver One',
        phoneNumber: '0911000099',
        roles: [UserRole.DRIVER],
        tin: '0011223344',
      },
    ],
  );
  const vehicles = repo();
  const rides = repo();
  const fares = repo();
  const verifications = repo();

  const service = new GovService(
    accessLogs as any,
    monthlyReports as any,
    legalRequests as any,
    legalEvents as any,
    reportJobs as any,
    bookings as any,
    subscriptions as any,
    trips as any,
    riderRequests as any,
    users as any,
    vehicles as any,
    rides as any,
    fares as any,
    verifications as any,
    { emitToUser: jest.fn() } as any,
    { send: jest.fn() } as any,
  );

  return {
    service,
    legalRequests,
    legalEvents,
    reportJobs,
    users,
  };
}

describe('GovService legal requests', () => {
  it('creates a request owned by the creating officer', async () => {
    const { service, legalRequests, legalEvents } = build();
    const out = await service.createLegalRequest('officer-1', {
      type: 'subpoena',
      title: 'Earnings disclosure',
      requestingAuthority: 'Federal High Court',
      caseReference: 'CASE-1',
      driverId: 'driver-1',
      dataScope: ['earnings', 'trips'],
      priority: 'high',
    });

    expect(out.status).toBe(GovLegalRequestStatus.RECEIVED);
    expect(out.createdByOfficerId).toBe('officer-1');
    expect(out.driverTin).toBe('0011223344');
    expect(legalRequests.rows).toHaveLength(1);
    expect(legalEvents.rows[0]).toMatchObject({
      action: 'created',
      actorId: 'officer-1',
    });
  });

  it('enforces status transitions and auto-assigns on review', async () => {
    const { service } = build({
      legal: [
        {
          id: 'lr-1',
          type: GovLegalRequestType.WARRANT,
          title: 'Trip trace',
          requestingAuthority: 'Police',
          caseReference: 'OPS-1',
          driverId: 'driver-1',
          driverTin: '0011223344',
          dataScope: ['trips'],
          priority: GovLegalRequestPriority.URGENT,
          status: GovLegalRequestStatus.RECEIVED,
          receivedAt: new Date('2026-01-10T00:00:00Z'),
          deadlineAt: null,
          assignedOfficerId: null,
          createdByOfficerId: 'officer-1',
          fulfilmentNotes: null,
          createdAt: new Date('2026-01-10T00:00:00Z'),
          updatedAt: new Date('2026-01-10T00:00:00Z'),
        },
      ],
    });

    const reviewed = await service.updateLegalRequestStatus(
      'lr-1',
      'officer-2',
      { status: 'in_review' },
    );
    expect(reviewed.status).toBe('in_review');
    expect(reviewed.assignedOfficerId).toBe('officer-2');

    await expect(
      service.updateLegalRequestStatus('lr-1', 'officer-2', {
        status: 'received',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const fulfilled = await service.updateLegalRequestStatus(
      'lr-1',
      'officer-2',
      { status: 'fulfilled', fulfilmentNotes: 'Disclosed' },
    );
    expect(fulfilled.status).toBe('fulfilled');
    expect(fulfilled.fulfilmentNotes).toBe('Disclosed');
  });

  it('assigns only open requests to a gov officer', async () => {
    const { service } = build({
      legal: [
        {
          id: 'lr-2',
          type: GovLegalRequestType.SUBPOENA,
          title: 'Tax file',
          requestingAuthority: 'MoR',
          caseReference: 'AUD-1',
          driverId: null,
          driverTin: '0099',
          dataScope: ['earnings'],
          priority: GovLegalRequestPriority.MEDIUM,
          status: GovLegalRequestStatus.RECEIVED,
          receivedAt: new Date(),
          deadlineAt: null,
          assignedOfficerId: null,
          createdByOfficerId: 'officer-1',
          fulfilmentNotes: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });

    const assigned = await service.assignLegalRequest('lr-2', 'officer-1', {
      officerId: 'officer-2',
    });
    expect(assigned.assignedOfficerId).toBe('officer-2');
    expect(assigned.status).toBe('in_review');

    await expect(
      service.assignLegalRequest('lr-2', 'officer-1', {
        officerId: 'driver-1',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('GovService report jobs', () => {
  it('rejects download when job is not ready', async () => {
    const { service } = build({
      reports: [
        {
          id: 'job-1',
          requestedByOfficerId: 'officer-1',
          driverId: 'driver-1',
          tin: '0011223344',
          fiscalYear: 2026,
          format: 'CSV',
          status: GovReportJobStatus.PROCESSING,
          parameters: {},
          resultCsv: null,
          rowCount: 0,
          grossTotal: null,
          netTaxableTotal: null,
          error: null,
          legalRequestId: null,
          createdAt: new Date(),
          completedAt: null,
        },
      ],
    });

    await expect(service.downloadReportJob('job-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('returns csv when ready', async () => {
    const { service } = build({
      reports: [
        {
          id: 'job-2',
          requestedByOfficerId: 'officer-1',
          driverId: 'driver-1',
          tin: '0011223344',
          fiscalYear: 2026,
          format: 'CSV',
          status: GovReportJobStatus.READY,
          parameters: { driverName: 'Driver One' },
          resultCsv: 'a,b\r\n1,2',
          rowCount: 1,
          grossTotal: '100',
          netTaxableTotal: '80',
          error: null,
          legalRequestId: null,
          createdAt: new Date(),
          completedAt: new Date(),
        },
      ],
    });

    const out = await service.downloadReportJob('job-2');
    expect(out.csv).toContain('a,b');
    expect(out.filename).toContain('0011223344');
  });
});

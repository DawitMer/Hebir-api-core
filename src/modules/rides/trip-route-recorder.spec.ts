import { TripRouteRecorderService } from './trip-route-recorder.service';

describe('TripRouteRecorderService', () => {
  let service: TripRouteRecorderService;
  let mockRedis: any;
  const store = new Map<string, string>();
  const listStore = new Map<string, string[]>();

  beforeEach(() => {
    store.clear();
    listStore.clear();

    mockRedis = {
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      set: jest.fn(async (key: string, val: string) => {
        store.set(key, val);
        return 'OK';
      }),
      del: jest.fn(async (...keys: string[]) => {
        keys.forEach((k) => {
          store.delete(k);
          listStore.delete(k);
        });
        return 1;
      }),
      lrange: jest.fn(async (key: string) => listStore.get(key) ?? []),
      pipeline: jest.fn(() => {
        const ops: Function[] = [];
        const pipe = {
          del: (...keys: string[]) => {
            ops.push(() => {
              keys.forEach((k) => {
                store.delete(k);
                listStore.delete(k);
              });
            });
            return pipe;
          },
          rpush: (key: string, val: string) => {
            ops.push(() => {
              const list = listStore.get(key) ?? [];
              list.push(val);
              listStore.set(key, list);
            });
            return pipe;
          },
          set: (key: string, val: string) => {
            ops.push(() => store.set(key, val));
            return pipe;
          },
          expire: () => pipe,
          incrby: (key: string, inc: number) => {
            ops.push(() => {
              const cur = parseInt(store.get(key) ?? '0', 10);
              const next = cur + inc;
              store.set(key, String(next));
              return [null, next];
            });
            return pipe;
          },
          exec: async () => {
            const res = ops.map((op) => op());
            return res.map((r) => [null, r]);
          },
        };
        return pipe;
      }),
    };

    service = new TripRouteRecorderService(mockRedis);
  });

  it('initializes route recording at pickup position', async () => {
    const rideId = 'ride-101';
    await service.startRecording(rideId, {
      lat: 8.9806,
      lng: 38.7578,
      timestampMs: 1000,
    });

    const route = await service.getRecordedRoute(rideId);
    expect(route).toHaveLength(1);
    expect(route[0].lat).toBe(8.9806);
    expect(await service.getAccumulatedDistance(rideId)).toBe(0);
  });

  it('accumulates valid distance along realistic movement path', async () => {
    const rideId = 'ride-102';
    await service.startRecording(rideId, {
      lat: 8.9806,
      lng: 38.7578,
      timestampMs: 1000,
    });

    // Move ~500m north over 30s (~60 km/h)
    const result1 = await service.recordGpsPoint(rideId, {
      lat: 8.9851,
      lng: 38.7578,
      timestampMs: 31000,
      accuracy: 8,
    });

    expect(result1.accepted).toBe(true);
    expect(result1.totalDistanceM).toBeGreaterThan(450);
    expect(result1.totalDistanceM).toBeLessThan(550);
  });

  it('discards impossible speed teleportation jumps', async () => {
    const rideId = 'ride-103';
    await service.startRecording(rideId, {
      lat: 8.9806,
      lng: 38.7578,
      timestampMs: 1000,
    });

    // 10km jump in 2 seconds (impossible 18,000 km/h)
    const result = await service.recordGpsPoint(rideId, {
      lat: 9.0706,
      lng: 38.7578,
      timestampMs: 3000,
      accuracy: 5,
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('impossible_speed_jump');
    expect(result.totalDistanceM).toBe(0);
  });

  it('filters poor GPS accuracy fixes', async () => {
    const rideId = 'ride-104';
    await service.startRecording(rideId, {
      lat: 8.9806,
      lng: 38.7578,
      timestampMs: 1000,
    });

    const result = await service.recordGpsPoint(rideId, {
      lat: 8.9820,
      lng: 38.7578,
      timestampMs: 10000,
      accuracy: 120, // poor fix
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('accuracy_too_poor');
  });

  it('clears Redis route state after settlement', async () => {
    const rideId = 'ride-105';
    await service.startRecording(rideId, {
      lat: 8.9806,
      lng: 38.7578,
      timestampMs: 1000,
    });
    await service.clearRoute(rideId);
    expect(mockRedis.del).toHaveBeenCalled();
  });
});

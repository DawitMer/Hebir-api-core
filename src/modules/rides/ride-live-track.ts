import Redis from 'ioredis';

/** Assigned-driver GPS is pushed only to this rider, never to the fleet. */
export const LIVE_TRACK_TTL_SEC = 4 * 60 * 60;

export function liveTrackKey(driverId: string): string {
  return `ride:live-track:${driverId}`;
}

export type RideLiveTrack = {
  rideId: string;
  riderId: string;
  status?: string;
  pickup?: { lat: number; lng: number };
  dropoff?: { lat: number; lng: number };
  distanceM?: number | null;
  durationS?: number | null;
};

export function liveTrackFromRide(ride: {
  id: string;
  riderId: string;
  status: string;
  pickup: { lat: number; lng: number };
  dropoff: { lat: number; lng: number };
  distanceM?: number | null;
  durationS?: number | null;
}): RideLiveTrack {
  return {
    rideId: ride.id,
    riderId: ride.riderId,
    status: ride.status,
    pickup: ride.pickup,
    dropoff: ride.dropoff,
    distanceM: ride.distanceM ?? null,
    durationS: ride.durationS ?? null,
  };
}

export async function writeLiveTrack(
  redis: Redis,
  driverId: string,
  track: RideLiveTrack,
): Promise<void> {
  await redis.set(
    liveTrackKey(driverId),
    JSON.stringify(track),
    'EX',
    LIVE_TRACK_TTL_SEC,
  );
}

export async function clearLiveTrack(
  redis: Redis,
  driverId: string | null | undefined,
  rideId: string,
): Promise<void> {
  if (!driverId) return;
  await redis.eval(
    `
    local raw = redis.call('GET', KEYS[1])
    if not raw then return 0 end
    local ok, value = pcall(cjson.decode, raw)
    if ok and value.rideId == ARGV[1] then return redis.call('DEL', KEYS[1]) end
    return 0
  `,
    1,
    liveTrackKey(driverId),
    rideId,
  );
}

export function parseLiveTrack(raw: string | null): RideLiveTrack | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as RideLiveTrack;
    if (parsed?.rideId && parsed?.riderId) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

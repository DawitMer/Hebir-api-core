import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import * as http from 'http';
import * as https from 'https';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { compassBearing, nearestAddisPlace } from './addis-places';

export interface GeoPointLike {
  lat: number;
  lng: number;
}

interface NominatimAddress {
  road?: string;
  pedestrian?: string;
  neighbourhood?: string;
  suburb?: string;
  city_district?: string;
  city?: string;
  town?: string;
  state?: string;
}

interface NominatimResponse {
  display_name?: string;
  address?: NominatimAddress;
}

interface GoogleAddressComponent {
  long_name: string;
  short_name: string;
  types: string[];
}

interface GoogleGeocodeResult {
  formatted_address?: string;
  address_components?: GoogleAddressComponent[];
}

interface GoogleGeocodeResponse {
  status: string;
  results?: GoogleGeocodeResult[];
  error_message?: string;
}

/** Coordinates rounded to ~11 m — enough precision for a street address. */
const CACHE_PRECISION = 4;
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;

/** Below this, the coordinate is treated as "at" the landmark. */
const AT_PLACE_RADIUS_M = 150;
/** Beyond this, naming the nearest landmark stops being meaningful. */
const MAX_PLACE_RADIUS_M = 8000;

/**
 * Turns coordinates into a human-readable street address.
 *
 * Priority Chain:
 * 1. Redis Cache (`geo:rev:lat:lng`)
 * 2. Official Google Maps Geocoding API (when GOOGLE_MAPS_API_KEY is configured)
 * 3. Nominatim / OpenStreetMap Geocoding API
 * 4. Offline Addis Ababa landmark centroids (degraded graceful fallback)
 */
@Injectable()
export class GeocodingService {
  private readonly logger = new Logger(GeocodingService.name);
  private readonly http: AxiosInstance;
  private readonly baseUrl: string;
  private readonly googleApiKey?: string;
  private readonly onlineEnabled: boolean;
  private readonly timeoutMs: number;

  /** Skip online lookups for a while after repeated failures (offline dev). */
  private consecutiveFailures = 0;
  private onlineMutedUntil = 0;
  private readonly failureThreshold: number;
  private readonly muteMs: number;

  constructor(
    config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    this.baseUrl = (
      config.get<string>('NOMINATIM_URL') ??
      'https://nominatim.openstreetmap.org'
    ).replace(/\/$/, '');
    this.googleApiKey = config.get<string>('GOOGLE_MAPS_API_KEY')?.trim();
    this.onlineEnabled =
      (config.get<string>('GEOCODING_ONLINE') ?? 'true') !== 'false';
    this.timeoutMs = Number(config.get<string>('GEOCODING_TIMEOUT_MS') ?? 2500);
    this.failureThreshold = Number(
      config.get<string>('GEOCODING_BREAKER_FAILURES') ?? 3,
    );
    this.muteMs = Number(
      config.get<string>('GEOCODING_BREAKER_OPEN_MS') ?? 60_000,
    );

    this.http = axios.create({
      timeout: this.timeoutMs,
      headers: {
        'User-Agent': 'Hebir/1.0 (ride-hailing; contact: ops@hebir.local)',
        'Accept-Language': 'en',
      },
      httpAgent: new http.Agent({ keepAlive: true, maxSockets: 20 }),
      httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 20 }),
    });

    if (this.googleApiKey) {
      this.logger.log(
        'Google Maps Geocoding API initialized with configured API key.',
      );
    }
  }

  /**
   * Best-effort address for a coordinate. Never throws — callers persist the
   * result directly, and a degraded description beats an empty column.
   */
  async reverseGeocode(point: GeoPointLike): Promise<string> {
    if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lng)) {
      return 'Unknown location';
    }

    const cacheKey = this.cacheKey(point);
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) return cached;
    } catch {
      // Cache is an optimization; fall through to a live lookup.
    }

    const online = await this.lookupOnline(point);
    const address = online ?? this.describeOffline(point);

    if (online) {
      try {
        await this.redis.set(cacheKey, address, 'EX', CACHE_TTL_SECONDS);
      } catch {
        // Ignore cache write failures.
      }
    }

    return address;
  }

  /**
   * Resolves both ends of a ride in parallel.
   */
  async reverseGeocodePair(
    pickup: GeoPointLike,
    dropoff: GeoPointLike,
  ): Promise<{ pickupAddress: string; dropoffAddress: string }> {
    const [pickupAddress, dropoffAddress] = await Promise.all([
      this.reverseGeocode(pickup),
      this.reverseGeocode(dropoff),
    ]);
    return { pickupAddress, dropoffAddress };
  }

  private cacheKey(point: GeoPointLike): string {
    return `geo:rev:${point.lat.toFixed(CACHE_PRECISION)}:${point.lng.toFixed(
      CACHE_PRECISION,
    )}`;
  }

  private get onlineMuted(): boolean {
    if (this.onlineMutedUntil === 0) return false;
    if (Date.now() >= this.onlineMutedUntil) {
      this.onlineMutedUntil = 0;
      this.consecutiveFailures = 0;
      return false;
    }
    return true;
  }

  private async lookupOnline(point: GeoPointLike): Promise<string | null> {
    if (!this.onlineEnabled || this.onlineMuted) return null;

    // 1. Try Google Maps Geocoding API if key configured
    if (this.googleApiKey) {
      try {
        const googleAddress = await this.lookupGoogleMaps(point);
        if (googleAddress) {
          this.consecutiveFailures = 0;
          return googleAddress;
        }
      } catch (err) {
        this.logger.debug(
          `Google Maps geocode failed, falling back to OSM: ${(err as Error).message}`,
        );
      }
    }

    // 2. Fallback to Nominatim / OSM Geocoding
    try {
      const { data } = await this.http.get<NominatimResponse>(
        `${this.baseUrl}/reverse`,
        {
          params: {
            lat: point.lat,
            lon: point.lng,
            format: 'jsonv2',
            zoom: 18,
            addressdetails: 1,
          },
        },
      );
      this.consecutiveFailures = 0;
      return this.formatNominatim(data);
    } catch (error) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.onlineMutedUntil = Date.now() + this.muteMs;
        this.logger.warn(
          `Reverse geocoding offline for ${this.muteMs}ms after ` +
            `${this.consecutiveFailures} failures: ${(error as Error).message}`,
        );
      }
      return null;
    }
  }

  private async lookupGoogleMaps(point: GeoPointLike): Promise<string | null> {
    const { data } = await this.http.get<GoogleGeocodeResponse>(
      'https://maps.googleapis.com/maps/api/geocode/json',
      {
        params: {
          latlng: `${point.lat},${point.lng}`,
          key: this.googleApiKey,
          language: 'en',
        },
      },
    );

    if (data?.status !== 'OK' || !data.results || data.results.length === 0) {
      return null;
    }

    return this.formatGoogleMaps(data.results);
  }

  private formatGoogleMaps(results: GoogleGeocodeResult[]): string | null {
    const best =
      results.find((r) =>
        r.address_components?.some((c) =>
          c.types.some((t) =>
            [
              'route',
              'street_address',
              'premise',
              'point_of_interest',
              'neighborhood',
            ].includes(t),
          ),
        ),
      ) ?? results[0];

    if (!best || !best.address_components) {
      return best?.formatted_address?.trim() || null;
    }

    const components = best.address_components;
    const getComp = (...types: string[]) =>
      components.find((c) => c.types.some((t) => types.includes(t)))?.long_name;

    const street = getComp('route', 'street_address');
    const neighborhood = getComp(
      'sublocality',
      'sublocality_level_1',
      'neighborhood',
    );
    const subCity = getComp(
      'administrative_area_level_2',
      'administrative_area_level_3',
    );
    const city =
      getComp('locality', 'administrative_area_level_1') ?? 'Addis Ababa';

    const parts = [street, neighborhood ?? subCity, city].filter(
      (p): p is string => Boolean(p && p.trim()),
    );

    if (parts.length === 0) {
      return best.formatted_address?.trim() || null;
    }

    return parts.join(', ');
  }

  private formatNominatim(data: NominatimResponse): string | null {
    const address = data?.address;
    if (!address) {
      return data?.display_name?.trim() || null;
    }

    const street = address.road ?? address.pedestrian;
    const area =
      address.neighbourhood ?? address.suburb ?? address.city_district;
    const city = address.city ?? address.town ?? address.state;

    const parts = [street, area, city].filter((part): part is string =>
      Boolean(part && part.trim()),
    );
    if (parts.length === 0) {
      return data.display_name?.trim() || null;
    }
    return parts.join(', ');
  }

  /**
   * Names the nearest known landmark, with distance + bearing when the point
   * is not right on top of it.
   */
  private describeOffline(point: GeoPointLike): string {
    const nearest = nearestAddisPlace(point);
    if (!nearest || nearest.distanceM > MAX_PLACE_RADIUS_M) {
      return `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
    }

    const { place, distanceM } = nearest;
    const suffix = `${place.subCity}, Addis Ababa`;
    if (distanceM <= AT_PLACE_RADIUS_M) {
      return `${place.name}, ${suffix}`;
    }

    const bearing = compassBearing(place, point);
    const distanceLabel =
      distanceM >= 1000
        ? `${(distanceM / 1000).toFixed(1)} km`
        : `${Math.round(distanceM / 10) * 10} m`;
    return `${distanceLabel} ${bearing} of ${place.name}, ${suffix}`;
  }
}

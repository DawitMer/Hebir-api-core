import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import * as http from 'http';
import * as https from 'https';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { GeoPointLike } from './geocoding.service';

export interface RouteDirectionsResult {
  distanceM: number;
  durationS: number;
  encodedPolyline?: string;
  summary?: string;
  points: GeoPointLike[];
}

interface GoogleDirectionsStep {
  distance: { value: number; text: string };
  duration: { value: number; text: string };
  polyline?: { points: string };
}

interface GoogleDirectionsLeg {
  distance: { value: number; text: string };
  duration: { value: number; text: string };
  steps?: GoogleDirectionsStep[];
}

interface GoogleDirectionsRoute {
  summary?: string;
  overview_polyline?: { points: string };
  legs?: GoogleDirectionsLeg[];
}

interface GoogleDirectionsResponse {
  status: string;
  routes?: GoogleDirectionsRoute[];
  error_message?: string;
}

const ROUTE_CACHE_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

@Injectable()
export class GoogleRoutesService {
  private readonly logger = new Logger(GoogleRoutesService.name);
  private readonly http: AxiosInstance;
  private readonly googleApiKey?: string;

  constructor(
    config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    this.googleApiKey = config.get<string>('GOOGLE_MAPS_API_KEY')?.trim();
    this.http = axios.create({
      timeout: 4000,
      headers: {
        'User-Agent': 'Hebir/1.0 (ride-hailing; contact: ops@hebir.local)',
      },
      httpAgent: new http.Agent({ keepAlive: true, maxSockets: 20 }),
      httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 20 }),
    });

    if (this.googleApiKey) {
      this.logger.log('Google Maps Directions & Routes Service initialized.');
    }
  }

  get isEnabled(): boolean {
    return Boolean(this.googleApiKey);
  }

  /**
   * Fetches the road-network driving route between origin and destination.
   */
  async getDirections(
    origin: GeoPointLike,
    destination: GeoPointLike,
  ): Promise<RouteDirectionsResult | null> {
    if (!this.googleApiKey) return null;
    if (
      !Number.isFinite(origin?.lat) ||
      !Number.isFinite(origin?.lng) ||
      !Number.isFinite(destination?.lat) ||
      !Number.isFinite(destination?.lng)
    ) {
      return null;
    }

    const cacheKey = `geo:route:${origin.lat.toFixed(4)},${origin.lng.toFixed(4)}:${destination.lat.toFixed(4)},${destination.lng.toFixed(4)}`;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached) as RouteDirectionsResult;
      }
    } catch {
      // Fall through to live API
    }

    try {
      const { data } = await this.http.get<GoogleDirectionsResponse>(
        'https://maps.googleapis.com/maps/api/directions/json',
        {
          params: {
            origin: `${origin.lat},${origin.lng}`,
            destination: `${destination.lat},${destination.lng}`,
            mode: 'driving',
            key: this.googleApiKey,
          },
        },
      );

      if (data?.status !== 'OK' || !data.routes || data.routes.length === 0) {
        return null;
      }

      const route = data.routes[0];
      const leg = route.legs?.[0];
      if (!leg) return null;

      const encodedPolyline = route.overview_polyline?.points;
      const points = encodedPolyline
        ? this.decodePolyline(encodedPolyline)
        : [origin, destination];

      const result: RouteDirectionsResult = {
        distanceM: leg.distance?.value ?? 0,
        durationS: leg.duration?.value ?? 0,
        encodedPolyline,
        summary: route.summary,
        points,
      };

      try {
        await this.redis.set(
          cacheKey,
          JSON.stringify(result),
          'EX',
          ROUTE_CACHE_TTL_SECONDS,
        );
      } catch {
        // Ignore cache write failure
      }

      return result;
    } catch (err) {
      this.logger.warn(
        `Google Directions request failed: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Decodes a Google Maps encoded polyline string into an array of coordinates.
   */
  decodePolyline(encoded: string): GeoPointLike[] {
    const points: GeoPointLike[] = [];
    let index = 0;
    const len = encoded.length;
    let lat = 0;
    let lng = 0;

    while (index < len) {
      let b: number;
      let shift = 0;
      let result = 0;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const dlat = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
      lat += dlat;

      shift = 0;
      result = 0;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const dlng = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
      lng += dlng;

      points.push({
        lat: lat / 1e5,
        lng: lng / 1e5,
      });
    }

    return points;
  }
}

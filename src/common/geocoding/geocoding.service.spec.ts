import { ConfigService } from '@nestjs/config';
import { GeocodingService } from './geocoding.service';
import { GoogleRoutesService } from './google-routes.service';

describe('GeocodingService & GoogleRoutesService', () => {
  let geocodingService: GeocodingService;
  let googleRoutesService: GoogleRoutesService;
  let mockRedis: any;

  beforeEach(() => {
    mockRedis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    };

    const mockConfig = {
      get: jest.fn((key: string) => {
        if (key === 'GOOGLE_MAPS_API_KEY')
          return 'AIzaSyALT734q6tNofHYu4TCrVtjHoOiw39PJXI';
        if (key === 'GEOCODING_ONLINE') return 'false'; // offline fallback test
        return undefined;
      }),
    } as unknown as ConfigService;

    geocodingService = new GeocodingService(mockConfig, mockRedis);
    googleRoutesService = new GoogleRoutesService(mockConfig, mockRedis);
  });

  describe('GeocodingService offline landmark fallback', () => {
    it('returns Bole landmark description for coordinates near Bole airport', async () => {
      const result = await geocodingService.reverseGeocode({
        lat: 8.9878,
        lng: 38.791,
      });
      expect(result).toContain('Bole');
      expect(result).toContain('Addis Ababa');
    });

    it('returns Meskel Square description for central coordinates', async () => {
      const result = await geocodingService.reverseGeocode({
        lat: 9.0105,
        lng: 38.7612,
      });
      expect(result).toContain('Meskel Square');
    });

    it('handles invalid coordinates gracefully', async () => {
      const result = await geocodingService.reverseGeocode({
        lat: NaN,
        lng: NaN,
      });
      expect(result).toBe('Unknown location');
    });
  });

  describe('GoogleRoutesService polyline decoding', () => {
    it('decodes Google encoded polyline string accurately', () => {
      const encoded = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
      const points = googleRoutesService.decodePolyline(encoded);

      expect(points).toHaveLength(3);
      expect(points[0].lat).toBeCloseTo(38.5, 1);
      expect(points[0].lng).toBeCloseTo(-120.2, 1);
      expect(points[1].lat).toBeCloseTo(40.7, 1);
      expect(points[1].lng).toBeCloseTo(-120.95, 1);
      expect(points[2].lat).toBeCloseTo(43.252, 2);
      expect(points[2].lng).toBeCloseTo(-126.453, 2);
    });

    it('reports isEnabled when GOOGLE_MAPS_API_KEY is configured', () => {
      expect(googleRoutesService.isEnabled).toBe(true);
    });
  });
});

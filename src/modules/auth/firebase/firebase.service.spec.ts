import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FirebaseService } from './firebase.service';

function configOf(map: Record<string, string>): ConfigService {
  return { get: (key: string) => map[key] } as ConfigService;
}

describe('FirebaseService mock-token gate', () => {
  it('accepts local test tokens outside the public API host', async () => {
    const service = new FirebaseService(
      configOf({
        NODE_ENV: 'test',
        PUBLIC_API_BASE_URL: 'http://127.0.0.1:3000',
      }),
    );
    await expect(
      service.verifyIdToken('test-token:+251911223344:uid-1'),
    ).resolves.toMatchObject({
      uid: 'uid-1',
      phoneNumber: '+251911223344',
    });
  });

  it('rejects mock tokens when NODE_ENV is development on the public host', async () => {
    const service = new FirebaseService(
      configOf({
        NODE_ENV: 'development',
        PUBLIC_API_BASE_URL: 'https://api.hebirtaxi.com',
      }),
    );
    await expect(
      service.verifyIdToken('test-token:+251911223344:uid-1'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      service.verifyIdToken('mock-firebase:+251911223344:uid-1'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

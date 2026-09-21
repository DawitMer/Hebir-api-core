import {
  isDriverKycEnforced,
  isPublicHebirApiHost,
  resolveTypeormSynchronize,
  treatAsProductionRuntime,
} from './public-api-host';

describe('public-api-host', () => {
  it('recognizes the live Hebir API hosts', () => {
    expect(isPublicHebirApiHost('https://api.hebirtaxi.com')).toBe(true);
    expect(isPublicHebirApiHost('https://api.hebirtaxi.com/')).toBe(true);
    expect(isPublicHebirApiHost('https://api.ridehebir.com')).toBe(true);
    expect(isPublicHebirApiHost('http://127.0.0.1:3000')).toBe(false);
    expect(isPublicHebirApiHost('https://ops.hebirtaxi.com')).toBe(false);
    expect(isPublicHebirApiHost('https://hebirtaxi.com')).toBe(false);
    expect(isPublicHebirApiHost(undefined)).toBe(false);
  });

  it('treats a mis-set NODE_ENV on the public host as production', () => {
    expect(
      treatAsProductionRuntime('development', 'https://api.hebirtaxi.com'),
    ).toBe(true);
    expect(
      treatAsProductionRuntime('development', 'http://127.0.0.1:3000'),
    ).toBe(false);
    expect(
      treatAsProductionRuntime('production', 'http://127.0.0.1:3000'),
    ).toBe(true);
  });

  it('enforces KYC on the public host unless explicitly disabled', () => {
    expect(
      isDriverKycEnforced({
        nodeEnv: 'development',
        publicApiBaseUrl: 'https://api.hebirtaxi.com',
      }),
    ).toBe(true);
    expect(
      isDriverKycEnforced({
        requireDriverKyc: 'false',
        nodeEnv: 'development',
        publicApiBaseUrl: 'https://api.hebirtaxi.com',
      }),
    ).toBe(false);
    expect(
      isDriverKycEnforced({
        requireDriverKyc: false,
        nodeEnv: 'development',
        publicApiBaseUrl: 'https://api.hebirtaxi.com',
      }),
    ).toBe(false);
    expect(
      isDriverKycEnforced({
        nodeEnv: 'development',
        publicApiBaseUrl: 'http://127.0.0.1:3000',
      }),
    ).toBe(false);
  });

  it('never enables TypeORM synchronize on the public host', () => {
    expect(
      resolveTypeormSynchronize({
        nodeEnv: 'development',
        publicApiBaseUrl: 'https://api.hebirtaxi.com',
        typeormSynchronize: 'true',
      }),
    ).toBe(false);
    expect(
      resolveTypeormSynchronize({
        nodeEnv: 'development',
        publicApiBaseUrl: 'http://127.0.0.1:3000',
        typeormSynchronize: 'true',
      }),
    ).toBe(true);
  });
});

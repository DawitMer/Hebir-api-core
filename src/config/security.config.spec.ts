import {
  buildCorsOptions,
  corsOriginDelegate,
  resolveAllowedOrigins,
} from './security.config';

describe('production CORS boundary', () => {
  it('does not silently add development origins to the production allowlist', () => {
    expect(
      resolveAllowedOrigins({
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://ops.example.com,https://gov.example.com',
        CORS_ALLOW_LOCAL: 'true',
      }),
    ).toEqual(['https://ops.example.com', 'https://gov.example.com']);
    expect(resolveAllowedOrigins({ NODE_ENV: 'production' })).toEqual([
      'https://ops.hebirtaxi.com',
      'https://gov.hebirtaxi.com',
      'https://hebirtaxi.com',
      'https://www.hebirtaxi.com',
    ]);
  });

  it('rejects unlisted browser origins but permits native clients without Origin', () => {
    const env = {
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://ops.example.com',
    };
    const callback = jest.fn();
    corsOriginDelegate('http://localhost:5174', callback, env);
    expect(callback).toHaveBeenLastCalledWith(null, false);
    corsOriginDelegate('https://ops.example.com.evil.test', callback, env);
    expect(callback).toHaveBeenLastCalledWith(null, false);
    corsOriginDelegate('https://ops.example.com', callback, env);
    expect(callback).toHaveBeenLastCalledWith(null, 'https://ops.example.com');
    corsOriginDelegate(undefined, callback, env);
    expect(callback).toHaveBeenLastCalledWith(null, true);
    expect(buildCorsOptions(env).credentials).toBe(true);
  });

  it('retains explicit development defaults outside production', () => {
    expect(resolveAllowedOrigins({ NODE_ENV: 'development' })).toContain(
      'http://localhost:5174',
    );
  });

  it('does not add localhost when NODE_ENV is development on the public API host', () => {
    expect(
      resolveAllowedOrigins({
        NODE_ENV: 'development',
        PUBLIC_API_BASE_URL: 'https://api.hebirtaxi.com',
        CORS_ORIGINS: 'https://ops.hebirtaxi.com',
      }),
    ).toEqual(['https://ops.hebirtaxi.com']);
    expect(
      resolveAllowedOrigins({
        NODE_ENV: 'development',
        PUBLIC_API_BASE_URL: 'https://api.hebirtaxi.com',
      }),
    ).not.toContain('http://localhost:5174');
  });
});

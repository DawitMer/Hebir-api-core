import { BadRequestException, HttpStatus } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import {
  AllExceptionsFilter,
  mapInfrastructureError,
} from './all-exceptions.filter';

describe('mapInfrastructureError', () => {
  it('does not echo SQL from a unique-violation', () => {
    const err = new QueryFailedError(
      'INSERT INTO secret',
      [],
      new Error('dup'),
    );
    const driverError = Object.assign(new Error('dup'), { code: '23505' });
    (
      err as QueryFailedError & { driverError: Error & { code: string } }
    ).driverError = driverError;
    expect(mapInfrastructureError(err)).toEqual({
      status: HttpStatus.CONFLICT,
      message: 'This record already exists',
    });
  });

  it('hides unknown database failures', () => {
    const err = new QueryFailedError(
      'SELECT password FROM user_accounts',
      [],
      new Error('boom'),
    );
    const mapped = mapInfrastructureError(err);
    expect(mapped.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(mapped.message).toBe('Internal server error');
    expect(mapped.message).not.toContain('password');
    expect(mapped.message).not.toContain('SELECT');
  });
});

describe('AllExceptionsFilter', () => {
  it('returns HttpException payloads without a stack', () => {
    const json = jest.fn();
    const res = { headersSent: false, status: jest.fn(() => ({ json })) };
    const filter = new AllExceptionsFilter();
    filter.catch(new BadRequestException('phone invalid'), {
      switchToHttp: () => ({
        getResponse: () => res,
        getRequest: () => ({
          method: 'POST',
          url: '/rides',
          headers: { 'x-request-id': 'req-1' },
        }),
      }),
    } as never);

    expect(res.status).toHaveBeenCalledWith(400);
    const body = json.mock.calls[0][0] as Record<string, unknown>;
    expect(body.message).toBe('phone invalid');
    expect(body.requestId).toBe('req-1');
    expect(body.stack).toBeUndefined();
  });
});

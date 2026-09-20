import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

export const ADVERTISER_TOKEN_TYPE = 'advertiser';

export type AdvertiserPrincipal = { advertiserId: string; email: string };

/**
 * Advertisers are not `user_accounts`; they carry their own JWT with
 * `typ: 'advertiser'`, so a rider/driver/admin access token can never reach
 * advertiser endpoints and vice versa.
 */
@Injectable()
export class AdvertiserAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<Request & { advertiser?: AdvertiserPrincipal }>();
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) throw new UnauthorizedException('Sign in to continue');
    let payload: { sub?: string; email?: string; typ?: string };
    try {
      payload = this.jwt.verify(token);
    } catch {
      throw new UnauthorizedException('Session expired — sign in again');
    }
    if (payload.typ !== ADVERTISER_TOKEN_TYPE || !payload.sub) {
      throw new UnauthorizedException('Not an advertiser session');
    }
    req.advertiser = { advertiserId: payload.sub, email: payload.email ?? '' };
    return true;
  }
}

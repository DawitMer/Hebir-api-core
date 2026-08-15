import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthService } from '../auth.service';
import { AccountStanding } from '../entities/user-account.entity';

export interface JwtPayload {
  sub: string;
  phoneNumber: string;
  roles: string[];
  typ?: string;
  jti?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly authService: AuthService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_ACCESS_SECRET'),
    });
  }

  async validate(payload: JwtPayload) {
    if (payload.typ && payload.typ !== 'access') {
      throw new UnauthorizedException('Invalid token type');
    }
    if (await this.authService.isAccessJtiDenied(payload.jti)) {
      throw new UnauthorizedException('Token revoked');
    }

    // Roles come from the database, not the token: a suspension or a revoked
    // role must take effect immediately, not when the access token expires.
    const context = await this.authService.getAuthContext(payload.sub);
    if (!context) {
      throw new UnauthorizedException('Account no longer exists');
    }
    if (context.standing === AccountStanding.BANNED) {
      throw new ForbiddenException('This account has been suspended');
    }

    return {
      userId: payload.sub,
      phoneNumber: payload.phoneNumber,
      roles: context.roles,
      jti: payload.jti,
    };
  }
}

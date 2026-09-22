import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../auth/entities/user-account.entity';
import { OPS_PERMISSIONS_KEY } from './require-permissions.decorator';
import type { OpsPermissionKey } from './permissions.catalog';
import { OpsRbacService } from './ops-rbac.service';

/**
 * Backend permission enforcement for Operations APIs.
 * Hiding a menu is not security — every protected route must use this.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly rbac: OpsRbacService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<OpsPermissionKey[]>(
      OPS_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest();
    const user = req.user as { userId?: string; roles?: string[] } | undefined;
    if (!user?.userId) {
      throw new ForbiddenException('Authentication required');
    }

    const roles = normalizeRoles(user.roles);
    const profile = await this.rbac.getStaffProfile(user.userId);
    if (profile && profile.status !== 'active') {
      throw new ForbiddenException('Staff account is disabled');
    }

    const permissions = await this.rbac.getPermissionKeysForUser(user.userId);

    // Bootstrap only: JWT ADMIN with no staff profile yet retains access so
    // first deploy can seed roles. Once a profile exists, role permissions win.
    if (permissions.size === 0) {
      if (!profile && roles.includes(UserRole.ADMIN)) {
        return true;
      }
      throw new ForbiddenException(
        `Missing permission: need one of ${required.join(', ')}`,
      );
    }

    const ok = required.some((p) => permissions.has(p));
    if (!ok) {
      throw new ForbiddenException(
        `Missing permission: need one of ${required.join(', ')}`,
      );
    }
    req.opsPermissions = [...permissions];
    return true;
  }
}

function normalizeRoles(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string' && raw.length > 0) {
    return raw
      .replace(/[{}]/g, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

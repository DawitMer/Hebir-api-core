import { ForbiddenException } from '@nestjs/common';
import { PermissionsGuard } from './permissions.guard';
import { OPS_PERMISSIONS_KEY } from './require-permissions.decorator';
import { UserRole } from '../auth/entities/user-account.entity';

describe('PermissionsGuard', () => {
  const reflector = {
    getAllAndOverride: jest.fn(),
  };
  const rbac = {
    getStaffProfile: jest.fn(),
    getPermissionKeysForUser: jest.fn(),
  };

  const guard = new PermissionsGuard(reflector as never, rbac as never);

  const ctx = (user?: { userId: string; roles?: string[] }) =>
    ({
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
    }) as never;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('allows when no permissions are required', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    await expect(guard.canActivate(ctx({ userId: 'u1' }))).resolves.toBe(true);
  });

  it('denies unauthenticated callers', async () => {
    reflector.getAllAndOverride.mockReturnValue(['pricing.edit']);
    await expect(guard.canActivate(ctx())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('denies disabled staff accounts', async () => {
    reflector.getAllAndOverride.mockReturnValue(['pricing.edit']);
    rbac.getStaffProfile.mockResolvedValue({ status: 'disabled' });
    await expect(
      guard.canActivate(ctx({ userId: 'u1', roles: [UserRole.ADMIN] })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows pricing_ops with pricing.edit', async () => {
    reflector.getAllAndOverride.mockReturnValue(['pricing.edit']);
    rbac.getStaffProfile.mockResolvedValue({ status: 'active' });
    rbac.getPermissionKeysForUser.mockResolvedValue(
      new Set(['pricing.view', 'pricing.edit', 'pricing.publish']),
    );
    await expect(
      guard.canActivate(ctx({ userId: 'u1', roles: [UserRole.ADMIN] })),
    ).resolves.toBe(true);
  });

  it('blocks support agent from creating super-admin actions (roles.manage)', async () => {
    reflector.getAllAndOverride.mockReturnValue(['roles.manage']);
    rbac.getStaffProfile.mockResolvedValue({ status: 'active' });
    rbac.getPermissionKeysForUser.mockResolvedValue(
      new Set(['support.view', 'support.manage', 'rides.view']),
    );
    await expect(
      guard.canActivate(ctx({ userId: 'u1', roles: [UserRole.ADMIN] })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('blocks dispatcher from pricing.publish', async () => {
    reflector.getAllAndOverride.mockReturnValue(['pricing.publish']);
    rbac.getStaffProfile.mockResolvedValue({ status: 'active' });
    rbac.getPermissionKeysForUser.mockResolvedValue(
      new Set(['rides.view', 'rides.manage', 'rides.force_cancel']),
    );
    await expect(
      guard.canActivate(ctx({ userId: 'u1', roles: [UserRole.ADMIN] })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('bootstrap ADMIN without staff profile may pass', async () => {
    reflector.getAllAndOverride.mockReturnValue(['pricing.publish']);
    rbac.getStaffProfile.mockResolvedValue(null);
    rbac.getPermissionKeysForUser.mockResolvedValue(new Set());
    await expect(
      guard.canActivate(ctx({ userId: 'u1', roles: [UserRole.ADMIN] })),
    ).resolves.toBe(true);
  });

  it('ADMIN with empty permissions after profile assignment is denied', async () => {
    reflector.getAllAndOverride.mockReturnValue(['pricing.publish']);
    rbac.getStaffProfile.mockResolvedValue({ status: 'active', roleId: 'r1' });
    rbac.getPermissionKeysForUser.mockResolvedValue(new Set());
    await expect(
      guard.canActivate(ctx({ userId: 'u1', roles: [UserRole.ADMIN] })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('OPS_PERMISSIONS_KEY', () => {
  it('is a stable metadata key', () => {
    expect(OPS_PERMISSIONS_KEY).toBe('ops_permissions');
  });
});

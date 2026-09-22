import { SetMetadata } from '@nestjs/common';
import type { OpsPermissionKey } from './permissions.catalog';

export const OPS_PERMISSIONS_KEY = 'ops_permissions';

/** Require ANY of the listed permissions (OR). */
export const RequirePermissions = (...permissions: OpsPermissionKey[]) =>
  SetMetadata(OPS_PERMISSIONS_KEY, permissions);

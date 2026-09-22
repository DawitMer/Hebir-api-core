import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { UserAccount, UserRole } from '../auth/entities/user-account.entity';
import { AuditTrail } from '../kyc/entities/audit-trail.entity';
import {
  OpsDepartment,
  OpsPermission,
  OpsRole,
  OpsRolePermission,
  OpsStaffProfile,
} from './entities/ops-rbac.entities';
import {
  OPS_DEPARTMENTS,
  OPS_PERMISSIONS,
  OPS_ROLE_SEEDS,
  type OpsPermissionKey,
} from './permissions.catalog';

@Injectable()
export class OpsRbacService implements OnModuleInit {
  private readonly logger = new Logger(OpsRbacService.name);
  private readonly permCache = new Map<string, { keys: Set<string>; exp: number }>();

  constructor(
    @InjectRepository(OpsDepartment)
    private readonly departments: Repository<OpsDepartment>,
    @InjectRepository(OpsPermission)
    private readonly permissions: Repository<OpsPermission>,
    @InjectRepository(OpsRole) private readonly roles: Repository<OpsRole>,
    @InjectRepository(OpsRolePermission)
    private readonly rolePermissions: Repository<OpsRolePermission>,
    @InjectRepository(OpsStaffProfile)
    private readonly staff: Repository<OpsStaffProfile>,
    @InjectRepository(UserAccount)
    private readonly users: Repository<UserAccount>,
    @InjectRepository(AuditTrail)
    private readonly audit: Repository<AuditTrail>,
  ) {}

  async onModuleInit() {
    await this.seedCatalog();
    await this.ensureAdminStaffProfiles();
  }

  async seedCatalog() {
    for (const d of OPS_DEPARTMENTS) {
      const existing = await this.departments.findOne({ where: { slug: d.slug } });
      if (!existing) {
        await this.departments.save(this.departments.create(d));
      }
    }
    for (const key of OPS_PERMISSIONS) {
      const existing = await this.permissions.findOne({ where: { key } });
      if (!existing) {
        await this.permissions.save(
          this.permissions.create({ key, description: key }),
        );
      }
    }
    const deptBySlug = Object.fromEntries(
      (await this.departments.find()).map((d) => [d.slug, d]),
    );
    const permByKey = Object.fromEntries(
      (await this.permissions.find()).map((p) => [p.key, p]),
    );

    for (const seed of OPS_ROLE_SEEDS) {
      let role = await this.roles.findOne({ where: { slug: seed.slug } });
      if (!role) {
        role = await this.roles.save(
          this.roles.create({
            slug: seed.slug,
            name: seed.name,
            departmentId: deptBySlug[seed.departmentSlug]?.id ?? null,
            isSystem: true,
            description: seed.name,
          }),
        );
      }
      const keys =
        seed.permissions === '*'
          ? [...OPS_PERMISSIONS]
          : seed.permissions;
      for (const key of keys) {
        const perm = permByKey[key];
        if (!perm) continue;
        const link = await this.rolePermissions.findOne({
          where: { roleId: role.id, permissionId: perm.id },
        });
        if (!link) {
          await this.rolePermissions.save(
            this.rolePermissions.create({
              roleId: role.id,
              permissionId: perm.id,
            }),
          );
        }
      }
    }
    this.logger.log('Ops RBAC catalog seeded');
  }

  /** Existing ADMIN accounts get a super_admin staff profile if missing. */
  async ensureAdminStaffProfiles() {
    const superRole = await this.roles.findOne({ where: { slug: 'super_admin' } });
    if (!superRole) return;
    const admins = await this.users
      .createQueryBuilder('u')
      .where(':role = ANY(u.roles)', { role: UserRole.ADMIN })
      .getMany();
    for (const admin of admins) {
      const existing = await this.staff.findOne({ where: { userId: admin.id } });
      if (existing) continue;
      await this.staff.save(
        this.staff.create({
          userId: admin.id,
          roleId: superRole.id,
          departmentId: superRole.departmentId,
          status: 'active',
          staffCode: `SA-${admin.id.slice(0, 8)}`,
        }),
      );
    }
  }

  async getPermissionKeysForUser(userId: string): Promise<Set<string>> {
    const cached = this.permCache.get(userId);
    if (cached && cached.exp > Date.now()) return cached.keys;

    const profile = await this.staff.findOne({
      where: { userId, status: 'active' },
    });
    const keys = new Set<string>();
    if (profile?.roleId) {
      const links = await this.rolePermissions.find({
        where: { roleId: profile.roleId },
      });
      if (links.length) {
        const perms = await this.permissions.find({
          where: { id: In(links.map((l) => l.permissionId)) },
        });
        for (const p of perms) keys.add(p.key);
      }
    }

    this.permCache.set(userId, { keys, exp: Date.now() + 30_000 });
    return keys;
  }

  async getStaffProfile(userId: string) {
    return this.staff.findOne({ where: { userId } });
  }

  async userHasPermission(
    userId: string,
    permission: OpsPermissionKey,
  ): Promise<boolean> {
    const keys = await this.getPermissionKeysForUser(userId);
    if (keys.has(permission)) return true;
    const profile = await this.staff.findOne({ where: { userId } });
    // Only bootstrap ADMIN without a staff profile gets implicit allow.
    if (profile) return false;
    const user = await this.users.findOne({ where: { id: userId } });
    return !!user?.roles?.includes(UserRole.ADMIN);
  }

  invalidateCache(userId?: string) {
    if (userId) this.permCache.delete(userId);
    else this.permCache.clear();
  }

  async getMe(userId: string) {
    const user = await this.users.findOne({ where: { id: userId } });
    const profile = await this.staff.findOne({
      where: { userId },
      relations: { role: true, department: true },
    });
    const permissions = [...(await this.getPermissionKeysForUser(userId))];
    return {
      userId,
      fullName: user?.fullName ?? null,
      phoneNumber: user?.phoneNumber ?? null,
      roles: user?.roles ?? [],
      staff: profile
        ? {
            id: profile.id,
            staffCode: profile.staffCode,
            status: profile.status,
            department: profile.department
              ? {
                  slug: profile.department.slug,
                  name: profile.department.name,
                }
              : null,
            role: profile.role
              ? { slug: profile.role.slug, name: profile.role.name }
              : null,
          }
        : null,
      permissions,
    };
  }

  async listStaff() {
    const rows = await this.staff.find({
      relations: { role: true, department: true },
      order: { createdAt: 'DESC' },
    });
    const userIds = rows.map((r) => r.userId);
    const users = userIds.length
      ? await this.users.find({ where: { id: In(userIds) } })
      : [];
    const byId = Object.fromEntries(users.map((u) => [u.id, u]));
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      staffCode: r.staffCode,
      status: r.status,
      fullName: byId[r.userId]?.fullName ?? null,
      phoneNumber: byId[r.userId]?.phoneNumber ?? null,
      department: r.department
        ? { slug: r.department.slug, name: r.department.name }
        : null,
      role: r.role ? { slug: r.role.slug, name: r.role.name } : null,
      lastLoginAt: r.lastLoginAt,
    }));
  }

  async assignRole(
    actorId: string,
    targetUserId: string,
    roleSlug: string,
  ) {
    const role = await this.roles.findOne({ where: { slug: roleSlug } });
    if (!role) throw new Error(`Unknown role ${roleSlug}`);
    let profile = await this.staff.findOne({ where: { userId: targetUserId } });
    if (!profile) {
      profile = this.staff.create({
        userId: targetUserId,
        status: 'active',
      });
    }
    const prev = profile.roleId;
    profile.roleId = role.id;
    profile.departmentId = role.departmentId;
    await this.staff.save(profile);
    this.invalidateCache(targetUserId);
    await this.audit.save(
      this.audit.create({
        actorId,
        actorRole: 'admin',
        action: 'staff.role_assign',
        targetType: 'user',
        targetId: targetUserId,
        metadata: { previousRoleId: prev, roleSlug },
      }),
    );
    return this.getMe(targetUserId);
  }

  async listRoles() {
    const roles = await this.roles.find({
      relations: { department: true },
      order: { name: 'ASC' },
    });
    const out = [];
    for (const role of roles) {
      const links = await this.rolePermissions.find({
        where: { roleId: role.id },
      });
      const perms = links.length
        ? await this.permissions.find({
            where: { id: In(links.map((l) => l.permissionId)) },
          })
        : [];
      out.push({
        id: role.id,
        slug: role.slug,
        name: role.name,
        isSystem: role.isSystem,
        department: role.department
          ? { slug: role.department.slug, name: role.department.name }
          : null,
        permissions: perms.map((p) => p.key),
      });
    }
    return out;
  }

  async listDepartments() {
    return this.departments.find({ order: { name: 'ASC' } });
  }
}

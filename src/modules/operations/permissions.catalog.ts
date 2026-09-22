/** Canonical ops permission keys — backend is source of truth. */
export const OPS_PERMISSIONS = [
  'rides.view',
  'rides.manage',
  'rides.force_cancel',
  'rides.reassign',
  'drivers.view',
  'drivers.manage',
  'drivers.suspend',
  'riders.view',
  'riders.manage',
  'pricing.view',
  'pricing.edit',
  'pricing.publish',
  'promotions.view',
  'promotions.manage',
  'payments.view',
  'payments.refund',
  'finance.view',
  'support.view',
  'support.manage',
  'incidents.view',
  'incidents.manage',
  'staff.view',
  'staff.create',
  'staff.edit',
  'staff.disable',
  'roles.view',
  'roles.manage',
  'audit.view',
  'system.settings.view',
  'system.settings.manage',
  'kyc.review',
  'ads.manage',
] as const;

export type OpsPermissionKey = (typeof OPS_PERMISSIONS)[number];

export const OPS_DEPARTMENTS: Array<{
  slug: string;
  name: string;
  description: string;
}> = [
  {
    slug: 'super_admin',
    name: 'Super Administration',
    description: 'Highest-level technical and business administration',
  },
  {
    slug: 'dispatch',
    name: 'Dispatch / Ride Operations',
    description: 'Live rides, matching, operational intervention',
  },
  {
    slug: 'rider_support',
    name: 'Rider Support',
    description: 'Rider cases, complaints, authorized refunds',
  },
  {
    slug: 'driver_ops',
    name: 'Driver Support / Driver Operations',
    description: 'Driver accounts, onboarding, documents',
  },
  {
    slug: 'safety',
    name: 'Safety / Incident Management',
    description: 'Emergencies, escalated safety cases',
  },
  {
    slug: 'finance',
    name: 'Finance / Payments',
    description: 'Fares, payouts, commissions, financial reports',
  },
  {
    slug: 'pricing',
    name: 'Pricing / Marketplace Operations',
    description: 'Base rates, surge caps, category pricing',
  },
  {
    slug: 'promotions',
    name: 'Promotions / Marketing',
    description: 'Campaigns and promotional codes',
  },
  {
    slug: 'compliance',
    name: 'Compliance',
    description: 'Verification and regulatory records',
  },
  {
    slug: 'fleet',
    name: 'Fleet / Vehicle Management',
    description: 'Vehicles, categories, vehicle status',
  },
  {
    slug: 'analytics',
    name: 'Analytics / Read Only',
    description: 'Reports without mutation rights',
  },
];

/** Role slug → permission keys. Super admin gets every key. */
export const OPS_ROLE_SEEDS: Array<{
  slug: string;
  name: string;
  departmentSlug: string;
  permissions: OpsPermissionKey[] | '*';
}> = [
  {
    slug: 'super_admin',
    name: 'Super Admin',
    departmentSlug: 'super_admin',
    permissions: '*',
  },
  {
    slug: 'dispatcher',
    name: 'Dispatcher',
    departmentSlug: 'dispatch',
    permissions: [
      'rides.view',
      'rides.manage',
      'rides.force_cancel',
      'rides.reassign',
      'drivers.view',
      'incidents.view',
    ],
  },
  {
    slug: 'rider_support',
    name: 'Rider Support Agent',
    departmentSlug: 'rider_support',
    permissions: [
      'riders.view',
      'riders.manage',
      'rides.view',
      'support.view',
      'support.manage',
      'payments.refund',
    ],
  },
  {
    slug: 'driver_ops',
    name: 'Driver Operations',
    departmentSlug: 'driver_ops',
    permissions: [
      'drivers.view',
      'drivers.manage',
      'drivers.suspend',
      'kyc.review',
      'support.view',
      'rides.view',
    ],
  },
  {
    slug: 'safety_officer',
    name: 'Safety Officer',
    departmentSlug: 'safety',
    permissions: [
      'incidents.view',
      'incidents.manage',
      'rides.view',
      'drivers.view',
      'drivers.suspend',
      'riders.view',
      'audit.view',
    ],
  },
  {
    slug: 'finance_analyst',
    name: 'Finance Analyst',
    departmentSlug: 'finance',
    permissions: [
      'finance.view',
      'payments.view',
      'payments.refund',
      'rides.view',
      'audit.view',
    ],
  },
  {
    slug: 'pricing_ops',
    name: 'Pricing Operations',
    departmentSlug: 'pricing',
    permissions: ['pricing.view', 'pricing.edit', 'pricing.publish', 'audit.view'],
  },
  {
    slug: 'promotions_ops',
    name: 'Promotions Operations',
    departmentSlug: 'promotions',
    permissions: ['promotions.view', 'promotions.manage', 'pricing.view'],
  },
  {
    slug: 'compliance_officer',
    name: 'Compliance Officer',
    departmentSlug: 'compliance',
    permissions: ['kyc.review', 'drivers.view', 'audit.view', 'rides.view'],
  },
  {
    slug: 'fleet_manager',
    name: 'Fleet Manager',
    departmentSlug: 'fleet',
    permissions: ['drivers.view', 'drivers.manage', 'kyc.review'],
  },
  {
    slug: 'analyst_readonly',
    name: 'Read-only Analyst',
    departmentSlug: 'analytics',
    permissions: [
      'rides.view',
      'drivers.view',
      'riders.view',
      'finance.view',
      'pricing.view',
      'audit.view',
    ],
  },
];

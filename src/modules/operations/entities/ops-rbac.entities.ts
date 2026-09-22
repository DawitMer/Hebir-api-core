import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('ops_departments')
export class OpsDepartment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ length: 64 })
  slug: string;

  @Column({ length: 120 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

@Entity('ops_permissions')
export class OpsPermission {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ length: 96 })
  key: string;

  @Column({ length: 255 })
  description: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

@Entity('ops_roles')
export class OpsRole {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ length: 64 })
  slug: string;

  @Column({ length: 120 })
  name: string;

  @Column({ type: 'uuid', nullable: true })
  departmentId: string | null;

  @ManyToOne(() => OpsDepartment, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'departmentId' })
  department: OpsDepartment | null;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ default: false })
  isSystem: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

@Entity('ops_role_permissions')
export class OpsRolePermission {
  @Column({ type: 'uuid', primary: true })
  roleId: string;

  @Column({ type: 'uuid', primary: true })
  permissionId: string;
}

@Entity('ops_staff_profiles')
export class OpsStaffProfile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  staffCode: string | null;

  @Column({ type: 'uuid', nullable: true })
  departmentId: string | null;

  @Column({ type: 'uuid', nullable: true })
  roleId: string | null;

  @ManyToOne(() => OpsRole, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'roleId' })
  role: OpsRole | null;

  @ManyToOne(() => OpsDepartment, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'departmentId' })
  department: OpsDepartment | null;

  @Column({ length: 32, default: 'active' })
  status: string;

  @Column({ type: 'timestamptz', nullable: true })
  lastLoginAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

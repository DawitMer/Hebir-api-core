import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  AccountStanding,
  UserAccount,
  UserRole,
} from '../auth/entities/user-account.entity';
import { AuthService } from '../auth/auth.service';
import {
  DriverProfile,
  DriverStatus,
} from '../rides/entities/driver-profile.entity';
import { Vehicle } from '../rides/entities/vehicle.entity';
import { Ride, RideStatus } from '../rides/entities/ride.entity';
import { UpdateMeDto } from './dto/update-me.dto';
import {
  DriverVerification,
  VerificationStatus,
} from '../kyc/entities/driver-verification.entity';

const ACTIVE_RIDE_STATUSES = [
  RideStatus.REQUESTED,
  RideStatus.SEARCHING,
  RideStatus.OFFERED,
  RideStatus.MATCHED,
  RideStatus.ACCEPTED,
  RideStatus.ARRIVING,
  RideStatus.IN_PROGRESS,
];

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(UserAccount)
    private readonly users: Repository<UserAccount>,
    @InjectRepository(DriverProfile)
    private readonly driverProfiles: Repository<DriverProfile>,
    @InjectRepository(Vehicle)
    private readonly vehicles: Repository<Vehicle>,
    @InjectRepository(Ride)
    private readonly rides: Repository<Ride>,
    @InjectRepository(DriverVerification)
    private readonly verifications: Repository<DriverVerification>,
    private readonly authService: AuthService,
  ) {}

  async getMe(userId: string) {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    return this.toPublicProfile(user);
  }

  async updateMe(userId: string, dto: UpdateMeDto) {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    if (dto.username !== undefined) {
      const username = dto.username.trim().replace(/^@+/, '');
      if (username) {
        const taken = await this.users.findOne({ where: { username } });
        if (taken && taken.id !== userId) {
          throw new ConflictException('Username already taken');
        }
        user.username = username;
      }
    }

    if (dto.fullName !== undefined) {
      user.fullName = dto.fullName.trim();
    }

    if (dto.savedPlaces !== undefined) {
      user.savedPlaces = dto.savedPlaces;
    }

    await this.users.save(user);

    const wantsVehicle =
      dto.vehicleMake ||
      dto.vehicleModel ||
      dto.vehiclePlate ||
      dto.vehicleColor ||
      dto.vehicleYear ||
      dto.vehicleCapacity;

    if (wantsVehicle) {
      // Vehicles drive dispatch eligibility — riders must not create them,
      // and no field is ever invented.
      if (!user.roles?.includes(UserRole.DRIVER)) {
        throw new ForbiddenException('Only drivers can register a vehicle');
      }
      await this.upsertVehicle(userId, dto);
    }

    return this.toPublicProfile(user);
  }

  /**
   * Soft-delete the caller's account. Phone/username are released so the
   * same number can register again. Ride history rows keep the UUID FK.
   */
  async deleteMe(userId: string, accessJti?: string) {
    const user = await this.users
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.id = :userId', { userId })
      .getOne();
    if (!user) throw new NotFoundException('User not found');
    if (user.standing === AccountStanding.DELETED) {
      await this.authService.logoutAll(userId, accessJti);
      return { deleted: true };
    }

    const active = await this.rides.findOne({
      where: [
        { riderId: userId, status: In(ACTIVE_RIDE_STATUSES) },
        { driverId: userId, status: In(ACTIVE_RIDE_STATUSES) },
      ],
    });
    if (active) {
      throw new ConflictException(
        'Finish or cancel your current ride before deleting your account',
      );
    }

    user.standing = AccountStanding.DELETED;
    user.phoneNumber = `deleted:${userId}`;
    user.username = null;
    user.fullName = null;
    user.tin = null;
    user.savedPlaces = null;
    user.passwordHash = null;
    await this.users.save(user);

    await this.driverProfiles.update(
      { userId },
      { status: DriverStatus.OFFLINE, idleSince: null },
    );

    this.authService.invalidateAuthContext(userId);
    await this.authService.logoutAll(userId, accessJti);
    return { deleted: true };
  }

  private async upsertVehicle(driverId: string, dto: UpdateMeDto) {
    const verification = await this.verifications.findOne({
      where: { driverId },
      order: { submittedAt: 'DESC' },
    });
    if (verification?.status === VerificationStatus.APPROVED) {
      throw new ConflictException(
        'This vehicle is approved and cannot be edited. Add a new vehicle to request a review.',
      );
    }

    let vehicle = await this.vehicles.findOne({ where: { driverId } });
    if (!vehicle) {
      const make = dto.vehicleMake?.trim();
      const model = dto.vehicleModel?.trim();
      const plate = dto.vehiclePlate?.trim();
      if (!make || !model || !plate) {
        throw new BadRequestException(
          'vehicleMake, vehicleModel and vehiclePlate are required to register a vehicle',
        );
      }
      vehicle = this.vehicles.create({
        driverId,
        make,
        model,
        plate,
        capacity: dto.vehicleCapacity ?? 4,
        color: dto.vehicleColor?.trim() || null,
      });
    } else {
      if (dto.vehicleMake) vehicle.make = dto.vehicleMake.trim();
      if (dto.vehicleModel) vehicle.model = dto.vehicleModel.trim();
      if (dto.vehiclePlate) vehicle.plate = dto.vehiclePlate.trim();
      if (dto.vehicleColor) vehicle.color = dto.vehicleColor.trim();
      if (dto.vehicleCapacity) vehicle.capacity = dto.vehicleCapacity;
    }
    await this.vehicles.save(vehicle);
  }

  private async toPublicProfile(user: UserAccount) {
    const driverProfile = await this.driverProfiles.findOne({
      where: { userId: user.id },
    });
    const vehicle = await this.vehicles.findOne({
      where: { driverId: user.id },
    });

    const isRider = user.roles?.includes(UserRole.RIDER);
    const isDriver = user.roles?.includes(UserRole.DRIVER);

    let tripCount = driverProfile?.totalTrips ?? 0;
    let rating: number | string = driverProfile?.ratingAvg ?? 0;

    // Pure riders (no driver role) get completed-ride count; rating stays 0.
    if (isRider && !isDriver) {
      tripCount = await this.rides.count({
        where: { riderId: user.id, status: RideStatus.COMPLETED },
      });
      rating = 0;
    }

    return {
      id: user.id,
      phoneNumber: user.phoneNumber,
      fullName: user.fullName,
      username: user.username,
      roles: user.roles,
      standing: user.standing,
      createdAt: user.createdAt,
      memberSinceLabel: this.formatJoined(user.createdAt),
      rating,
      tripCount,
      driverStatus: driverProfile?.status ?? null,
      savedPlaces: user.savedPlaces ?? [],
      vehicle: vehicle
        ? {
            make: vehicle.make,
            model: vehicle.model,
            makeModel: `${vehicle.make} ${vehicle.model}`.trim(),
            plate: vehicle.plate,
            color: vehicle.color,
            capacity: vehicle.capacity,
          }
        : null,
    };
  }

  private formatJoined(date: Date): string {
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    return `${months[date.getUTCMonth()]} '${String(date.getUTCFullYear()).slice(2)}`;
  }
}

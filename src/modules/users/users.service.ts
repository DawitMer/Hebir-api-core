import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserAccount, UserRole } from '../auth/entities/user-account.entity';
import { DriverProfile } from '../rides/entities/driver-profile.entity';
import { Vehicle } from '../rides/entities/vehicle.entity';
import { Ride, RideStatus } from '../rides/entities/ride.entity';
import { UpdateMeDto } from './dto/update-me.dto';

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

  private async upsertVehicle(driverId: string, dto: UpdateMeDto) {
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

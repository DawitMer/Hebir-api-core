import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Rating } from './entities/rating.entity';
import { Ride, RideStatus } from '../rides/entities/ride.entity';
import { DriverProfile } from '../rides/entities/driver-profile.entity';
import { CreateRatingDto } from './dto/create-rating.dto';

@Injectable()
export class RatingsService {
  private readonly logger = new Logger(RatingsService.name);

  constructor(
    @InjectRepository(Rating) private readonly ratings: Repository<Rating>,
    @InjectRepository(Ride) private readonly rides: Repository<Ride>,
    @InjectRepository(DriverProfile)
    private readonly driverProfiles: Repository<DriverProfile>,
  ) {}

  /**
   * Rates the other party on a completed ride. `ratedUser` is always
   * derived from the ride — a rider rates the driver and vice versa,
   * never a value taken directly from client input.
   */
  async createRating(ratedBy: string, dto: CreateRatingDto): Promise<Rating> {
    const ride = await this.rides.findOne({ where: { id: dto.rideId } });
    if (!ride) throw new NotFoundException('Ride not found');
    if (ride.status !== RideStatus.COMPLETED) {
      throw new ConflictException('Only completed rides can be rated');
    }

    let ratedUser: string;
    if (ride.riderId === ratedBy) {
      if (!ride.driverId)
        throw new ConflictException('This ride has no matched driver');
      ratedUser = ride.driverId;
    } else if (ride.driverId === ratedBy) {
      ratedUser = ride.riderId;
    } else {
      throw new ForbiddenException('You are not a participant on this ride');
    }

    const existing = await this.ratings.findOne({
      where: { rideId: ride.id, ratedBy },
    });
    if (existing) {
      throw new ConflictException('You have already rated this ride');
    }

    const rating = await this.ratings.save(
      this.ratings.create({
        rideId: ride.id,
        ratedBy,
        ratedUser,
        stars: dto.stars,
        comment: dto.comment ?? null,
      }),
    );

    if (ratedUser === ride.driverId) {
      await this.recomputeDriverRating(ratedUser);
    }

    this.logger.log(
      `Rating ${rating.id}: ${dto.stars}★ for ${ratedUser} (by ${ratedBy}) on ride ${ride.id}`,
    );
    return rating;
  }

  private async recomputeDriverRating(driverId: string): Promise<void> {
    const lastRatings = await this.ratings.find({
      where: { ratedUser: driverId },
      order: { createdAt: 'DESC' },
      take: 100,
    });

    if (lastRatings.length === 0) return;

    const sum = lastRatings.reduce((acc, r) => acc + r.stars, 0);
    const avg = sum / lastRatings.length;

    const profile = await this.driverProfiles.findOne({
      where: { userId: driverId },
    });
    if (profile) {
      profile.ratingAvg = String(Math.round(avg * 100) / 100);
      await this.driverProfiles.save(profile);
    }
  }
}

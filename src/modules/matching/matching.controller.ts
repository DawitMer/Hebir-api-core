import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { MatchingService } from './matching.service';
import { PublishTripDto } from './dto/publish-trip.dto';
import { SubmitRiderRequestDto } from './dto/submit-request.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../auth/entities/user-account.entity';
import { SubscriptionAccessGuard } from '../../common/guards/subscription-access.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@Controller()
export class MatchingController {
  constructor(private readonly matchingService: MatchingService) {}

  @UseGuards(JwtAuthGuard, RolesGuard, SubscriptionAccessGuard)
  @Roles(UserRole.DRIVER, UserRole.ADMIN)
  @Post('trips')
  publishTrip(
    @CurrentUser() user: { userId: string },
    @Body() dto: PublishTripDto,
  ) {
    return this.matchingService.publishTrip(user.userId, dto);
  }

  /**
   * Whether the Shared ride option should be offered at this pickup —
   * true only when other riders are queued nearby or carpool trips with
   * free seats exist. GET /matching/availability?lat=&lng=
   */
  @UseGuards(JwtAuthGuard)
  @Get('matching/availability')
  shareAvailability(
    @CurrentUser() user: { userId: string },
    @Query('lat') lat: string,
    @Query('lng') lng: string,
  ) {
    const pickup = { lat: Number(lat), lng: Number(lng) };
    if (!Number.isFinite(pickup.lat) || !Number.isFinite(pickup.lng)) {
      throw new BadRequestException('lat and lng are required');
    }
    return this.matchingService.shareAvailability(user.userId, pickup);
  }

  @UseGuards(JwtAuthGuard)
  @Post('rider-requests')
  submitRequest(
    @CurrentUser() user: { userId: string },
    @Body() dto: SubmitRiderRequestDto,
  ) {
    return this.matchingService.submitRequest(user.userId, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Get('rider-requests/:id/matches')
  getMatches(
    @CurrentUser() user: { userId: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.matchingService.findMatches(id, user.userId);
  }
}

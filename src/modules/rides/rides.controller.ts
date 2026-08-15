import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { RidesService } from './rides.service';
import { RequestRideDto } from './dto/request-ride.dto';
import { TransitionRideDto } from './dto/transition-ride.dto';
import { ListRidesDto } from './dto/list-rides.dto';
import { SendRideMessageDto } from './dto/send-ride-message.dto';
import { LookupRiderDto } from './dto/lookup-rider.dto';
import { DriverInitiatedRideDto } from './dto/driver-initiated-ride.dto';
import { StartRideDto } from './dto/start-ride.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RedisRateLimitGuard } from '../../common/rate-limit/redis-rate-limit.guard';
import {
  RateLimit,
  RateLimitPresets,
} from '../../common/rate-limit/rate-limit.decorator';
import { UserRole } from '../auth/entities/user-account.entity';

type AuthedUser = { userId: string; roles?: UserRole[] };

@Controller('rides')
export class RidesController {
  constructor(private readonly ridesService: RidesService) {}

  @UseGuards(JwtAuthGuard, RedisRateLimitGuard)
  @RateLimit(RateLimitPresets.rideRequest)
  @Post()
  requestRide(@CurrentUser() user: AuthedUser, @Body() dto: RequestRideDto) {
    return this.ridesService.requestRide(user.userId, dto);
  }

  /** Exact phone lookup for street-hail / "join my phone" trips. */
  @UseGuards(JwtAuthGuard, RedisRateLimitGuard)
  @RateLimit({
    prefix: 'rl:rider-lookup',
    limit: 20,
    windowSec: 60,
    keyBy: 'user',
  })
  @Post('lookup-rider')
  lookupRider(@CurrentUser() user: AuthedUser, @Body() dto: LookupRiderDto) {
    return this.ridesService.lookupRiderByPhone(
      user.userId,
      dto.phoneNumber,
      dto.driverLocation,
    );
  }

  /** Driver creates an assigned ride; rider gets a privacy start code. */
  @UseGuards(JwtAuthGuard, RedisRateLimitGuard)
  @RateLimit(RateLimitPresets.rideRequest)
  @Post('driver-initiated')
  driverInitiated(
    @CurrentUser() user: AuthedUser,
    @Body() dto: DriverInitiatedRideDto,
  ) {
    return this.ridesService.createDriverInitiatedRide(user.userId, dto);
  }

  /** Current live offer for this driver (one-shot reconnect catch-up). */
  @UseGuards(JwtAuthGuard)
  @Get('offers/current')
  getCurrentOffer(@CurrentUser() user: AuthedUser) {
    return this.ridesService.getCurrentOffer(user.userId);
  }

  /** Driver's live assigned trip (resume after app kill / leave mid-trip). */
  @UseGuards(JwtAuthGuard)
  @Get('active')
  async getActive(@CurrentUser() user: AuthedUser) {
    return (
      (await this.ridesService.getActiveRideForDriver(user.userId)) ?? {}
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('mine')
  listMine(@CurrentUser() user: AuthedUser, @Query() query: ListRidesDto) {
    return this.ridesService.listRidesForRider(user.userId, query.limit);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id/messages')
  listMessages(
    @CurrentUser() user: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ridesService.listRideMessages(id, user.userId);
  }

  @UseGuards(JwtAuthGuard, RedisRateLimitGuard)
  @RateLimit(RateLimitPresets.rideRequest)
  @Post(':id/messages')
  sendMessage(
    @CurrentUser() user: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendRideMessageDto,
  ) {
    return this.ridesService.sendRideMessage(id, user.userId, dto.body);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/start')
  startWithCode(
    @CurrentUser() user: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StartRideDto,
  ) {
    return this.ridesService.startRideWithCode(id, user.userId, dto.startCode);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  getRide(
    @CurrentUser() user: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ridesService.getRide(id, user);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/accept')
  accept(
    @CurrentUser() user: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ridesService.acceptOffer(user.userId, id);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/decline')
  decline(
    @CurrentUser() user: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ridesService.declineOffer(user.userId, id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id/status')
  transition(
    @CurrentUser() user: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransitionRideDto,
  ) {
    return this.ridesService.transitionStatus(
      id,
      user.userId,
      dto.status,
      dto.note,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/complete')
  complete(
    @CurrentUser() user: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ridesService.completeRide(id, user.userId);
  }
}

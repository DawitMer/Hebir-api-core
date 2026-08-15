import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { BookingService, DriverDecision } from './booking.service';
import { SelectMatchDto } from './dto/select-match.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { SubscriptionAccessGuard } from '../../common/guards/subscription-access.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@Controller('bookings')
export class BookingController {
  constructor(private readonly bookingService: BookingService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  selectMatch(
    @CurrentUser() user: { userId: string },
    @Body() dto: SelectMatchDto,
  ) {
    return this.bookingService.selectMatch(user.userId, dto);
  }

  /** Participants only — the rider polls this while the hold awaits the driver. */
  @UseGuards(JwtAuthGuard)
  @Get(':id')
  getBooking(
    @CurrentUser() user: { userId: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.bookingService.getBookingForParticipant(user.userId, id);
  }

  @UseGuards(JwtAuthGuard, SubscriptionAccessGuard)
  @Post(':id/accept')
  accept(@CurrentUser() user: { userId: string }, @Param('id') id: string) {
    return this.bookingService.driverRespond(user.userId, id, 'accept' as DriverDecision);
  }

  @UseGuards(JwtAuthGuard, SubscriptionAccessGuard)
  @Post(':id/decline')
  decline(@CurrentUser() user: { userId: string }, @Param('id') id: string) {
    return this.bookingService.driverRespond(user.userId, id, 'decline' as DriverDecision);
  }
}

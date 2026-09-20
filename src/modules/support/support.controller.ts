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
import { SupportService } from './support.service';
import { ListRideMessagesDto } from '../rides/dto/list-ride-messages.dto';
import {
  SendSupportMessageDto,
  UpdateSupportThreadDto,
} from './dto/support.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../auth/entities/user-account.entity';
import { RedisRateLimitGuard } from '../../common/rate-limit/redis-rate-limit.guard';
import {
  RateLimit,
  RateLimitPresets,
} from '../../common/rate-limit/rate-limit.decorator';

@Controller('support')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.RIDER, UserRole.DRIVER)
  @Get('threads/mine')
  mine(
    @CurrentUser() user: { userId: string; roles: string[] },
    @Query() query: ListRideMessagesDto,
  ) {
    return this.support.getOrCreateMine(user.userId, user.roles ?? [], query);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, RedisRateLimitGuard)
  @Roles(UserRole.RIDER, UserRole.DRIVER)
  @RateLimit(RateLimitPresets.chat)
  @Post('threads/mine/messages')
  sendMine(
    @CurrentUser() user: { userId: string; roles: string[] },
    @Body() dto: SendSupportMessageDto,
  ) {
    return this.support.postUserMessage(
      user.userId,
      user.roles ?? [],
      dto.body,
      dto.clientMessageId,
    );
  }
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/support')
export class AdminSupportController {
  constructor(private readonly support: SupportService) {}

  @Get('threads')
  list(
    @Query('status') status?: string,
    @Query('limit') limitRaw?: string,
    @Query('before') before?: string,
  ) {
    const limit = limitRaw ? Number(limitRaw) : undefined;
    return this.support.listThreads(status, {
      limit: Number.isFinite(limit) ? limit : undefined,
      before,
    });
  }

  @Get('threads/:id')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListRideMessagesDto,
  ) {
    return this.support.getThreadForStaff(id, query);
  }

  @UseGuards(RedisRateLimitGuard)
  @RateLimit(RateLimitPresets.chat)
  @Post('threads/:id/messages')
  reply(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: SendSupportMessageDto,
  ) {
    return this.support.postAgentMessage(
      id,
      user.userId,
      dto.body,
      dto.clientMessageId,
    );
  }

  @Patch('threads/:id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: UpdateSupportThreadDto,
  ) {
    return this.support.updateThread(id, user.userId, dto);
  }
}

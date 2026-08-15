import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { OtpService, RequestOtpDto, VerifyOtpDto } from './otp.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { OtpLoginDto } from './dto/otp-login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RedisRateLimitGuard } from '../../common/rate-limit/redis-rate-limit.guard';
import {
  RateLimit,
  RateLimitPresets,
} from '../../common/rate-limit/rate-limit.decorator';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly otpService: OtpService,
  ) {}

  @UseGuards(RedisRateLimitGuard)
  @RateLimit(RateLimitPresets.auth)
  @Post('otp/request')
  requestOtp(@Body() dto: RequestOtpDto) {
    return this.otpService.request(dto.phoneNumber);
  }

  @UseGuards(RedisRateLimitGuard)
  @RateLimit(RateLimitPresets.auth)
  @Post('otp/verify')
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.otpService.verify(dto.phoneNumber, dto.code);
  }

  /** Passwordless login/signup for rider & driver apps. */
  @UseGuards(RedisRateLimitGuard)
  @RateLimit(RateLimitPresets.auth)
  @Post('otp/login')
  loginWithOtp(@Body() dto: OtpLoginDto) {
    return this.authService.loginWithOtp(dto);
  }

  @UseGuards(RedisRateLimitGuard)
  @RateLimit(RateLimitPresets.auth)
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  /** Staff (ops/gov) password login. Rider/driver accounts reject this. */
  @UseGuards(RedisRateLimitGuard)
  @RateLimit(RateLimitPresets.auth)
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @UseGuards(RedisRateLimitGuard)
  @RateLimit(RateLimitPresets.authRefresh)
  @Post('refresh')
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  @UseGuards(RedisRateLimitGuard)
  @RateLimit(RateLimitPresets.authRefresh)
  @Post('logout')
  logout(@Body() dto: RefreshTokenDto) {
    return this.authService.logout(dto.refreshToken);
  }

  @UseGuards(JwtAuthGuard, RedisRateLimitGuard)
  @RateLimit(RateLimitPresets.authRefresh)
  @Post('logout-all')
  logoutAll(@CurrentUser() user: { userId: string; jti?: string }) {
    return this.authService.logoutAll(user.userId, user.jti);
  }
}

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { KycService } from './kyc.service';
import { ReviewDecisionDto } from './dto/review-decision.dto';
import { VerificationStatus } from './entities/driver-verification.entity';
import {
  ConfirmDocumentDto,
  PresignDocumentDto,
  StartVerificationDto,
} from './dto/document-upload.dto';
import { KycStorageService } from './kyc-storage.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../auth/entities/user-account.entity';

@Controller('kyc')
export class KycController {
  constructor(
    private readonly kycService: KycService,
    private readonly storage: KycStorageService,
  ) {}

  // --- Driver self-service (presigned upload) ---

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.DRIVER, UserRole.ADMIN)
  @Post('me/verification')
  startMyVerification(
    @CurrentUser() user: { userId: string },
    @Body() dto: StartVerificationDto,
  ) {
    return this.kycService.startOrGetMyVerification(user.userId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.DRIVER, UserRole.ADMIN)
  @Get('me/verification')
  myVerification(@CurrentUser() user: { userId: string }) {
    return this.kycService.getMyVerification(user.userId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.DRIVER, UserRole.ADMIN)
  @Get('me/documents')
  myDocuments(@CurrentUser() user: { userId: string }) {
    return this.kycService.listMyDocuments(user.userId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.DRIVER, UserRole.ADMIN)
  @Post('me/documents/presign')
  presign(
    @CurrentUser() user: { userId: string },
    @Body() dto: PresignDocumentDto,
  ) {
    return this.kycService.createPresign(user.userId, dto);
  }

  /** Local-storage PUT target (S3 mode uses the real S3 URL instead). */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.DRIVER, UserRole.ADMIN)
  @Put('me/documents/upload-body')
  async uploadBody(
    @CurrentUser() user: { userId: string },
    @Query('key') key: string,
    @Req() req: { rawBody?: Buffer; headers: Record<string, string | string[] | undefined> },
  ) {
    if (!key) throw new BadRequestException('key is required');
    const body = req.rawBody;
    if (!body?.length) throw new BadRequestException('Empty body');
    const contentType = req.headers['content-type'];
    return this.kycService.saveLocalUpload(
      user.userId,
      key,
      body,
      typeof contentType === 'string' ? contentType : undefined,
    );
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.DRIVER, UserRole.ADMIN)
  @Post('me/documents/confirm')
  confirm(
    @CurrentUser() user: { userId: string },
    @Body() dto: ConfirmDocumentDto,
  ) {
    return this.kycService.confirmUpload(user.userId, dto);
  }

  /** HMAC-signed local file view (for <img src> without JWT). */
  @Get('documents/view-local')
  async viewLocal(
    @Query('key') key: string,
    @Query('exp') expRaw: string,
    @Query('sig') sig: string,
    @Res() res: Response,
  ) {
    const exp = Number(expRaw);
    if (!key || !sig || !this.storage.verifyViewSignature(key, exp, sig)) {
      throw new BadRequestException('Invalid or expired view link');
    }
    const bytes = await this.kycService.readLocalForAdmin(key);
    if (!bytes) throw new BadRequestException('File not found');
    const lower = key.toLowerCase();
    const type = lower.endsWith('.png')
      ? 'image/png'
      : lower.endsWith('.webp')
        ? 'image/webp'
        : lower.endsWith('.pdf')
          ? 'application/pdf'
          : 'image/jpeg';
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(bytes);
  }

  // --- Admin review ---

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get('queue')
  listQueue(@Query('status') status?: VerificationStatus) {
    return this.kycService.listQueue(status);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get('compliance/alerts')
  alerts() {
    return this.kycService.listComplianceAlerts();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get('compliance/expirations')
  expirations() {
    return this.kycService.listDocumentExpirations();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Post('compliance/alerts/:id/resolve')
  resolveAlert(
    @Param('id') id: string,
    @CurrentUser() user: { userId: string; roles: string[] },
  ) {
    return this.kycService.resolveAlert(id, user.userId, user.roles.join(','));
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get('audit-trail')
  auditTrail(@Query('targetId') targetId?: string) {
    return this.kycService.listAuditTrail(targetId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get(':id/documents')
  documents(@Param('id') id: string) {
    return this.kycService.listDocuments(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get(':id')
  get(@Param('id') id: string) {
    return this.kycService.getVerification(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Post(':id/assign/:agentId')
  assign(
    @Param('id') id: string,
    @Param('agentId') agentId: string,
    @CurrentUser() user: { userId: string; roles: string[] },
  ) {
    return this.kycService.assign(id, agentId, user.userId, user.roles.join(','));
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Post(':id/decision')
  decide(
    @Param('id') id: string,
    @Body() dto: ReviewDecisionDto,
    @CurrentUser() user: { userId: string; roles: string[] },
  ) {
    return this.kycService.decide(id, dto, user.userId, user.roles.join(','));
  }
}

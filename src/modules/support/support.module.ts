import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SupportThread } from './entities/support-thread.entity';
import { SupportMessage } from './entities/support-message.entity';
import { UserAccount } from '../auth/entities/user-account.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { SupportService } from './support.service';
import {
  AdminSupportController,
  SupportController,
} from './support.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([SupportThread, SupportMessage, UserAccount]),
    NotificationsModule,
  ],
  controllers: [SupportController, AdminSupportController],
  providers: [SupportService],
})
export class SupportModule {}

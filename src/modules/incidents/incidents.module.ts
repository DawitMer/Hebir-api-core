import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Incident } from './entities/incident.entity';
import { UserAccount } from '../auth/entities/user-account.entity';
import { Ride } from '../rides/entities/ride.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { IncidentsService } from './incidents.service';
import { IncidentsController } from './incidents.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([Incident, UserAccount, Ride]),
    NotificationsModule,
  ],
  controllers: [IncidentsController],
  providers: [IncidentsService],
  exports: [IncidentsService],
})
export class IncidentsModule {}

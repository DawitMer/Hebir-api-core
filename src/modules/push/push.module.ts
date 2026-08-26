import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeviceToken } from './device-token.entity';
import { PushService } from './push.service';

@Module({
  imports: [TypeOrmModule.forFeature([DeviceToken])],
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}

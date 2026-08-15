import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GeocodingService } from './geocoding.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [GeocodingService],
  exports: [GeocodingService],
})
export class GeocodingModule {}

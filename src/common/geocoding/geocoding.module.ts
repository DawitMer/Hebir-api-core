import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GeocodingService } from './geocoding.service';
import { GoogleRoutesService } from './google-routes.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [GeocodingService, GoogleRoutesService],
  exports: [GeocodingService, GoogleRoutesService],
})
export class GeocodingModule {}

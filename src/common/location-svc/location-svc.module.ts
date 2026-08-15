import { Global, Module } from '@nestjs/common';
import { LocationSvcClient } from './location-svc.client';

@Global()
@Module({
  providers: [LocationSvcClient],
  exports: [LocationSvcClient],
})
export class LocationSvcModule {}

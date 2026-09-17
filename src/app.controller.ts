import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get()
  getHello(): Record<string, string> {
    return {
      service: 'api-core',
      status: 'online',
      message: 'Hebir API Core is running.',
    };
  }
}

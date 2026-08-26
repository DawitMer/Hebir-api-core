import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { TipsService } from './tips.service';
import { CreateTipDto } from './dto/create-tip.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@Controller('tips')
export class TipsController {
  constructor(private readonly tipsService: TipsService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  createTip(
    @CurrentUser() user: { userId: string },
    @Body() dto: CreateTipDto,
  ) {
    return this.tipsService.createTip(user.userId, dto);
  }
}

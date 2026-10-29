import { Body, Controller, Post, Put, HttpCode, HttpStatus } from '@nestjs/common';
import { ToneService } from './tone.service';
import {
  PreviewToneEmailDto,
  RebuildToneProfileDto,
  SaveToneSamplesDto,
} from './dto/tone.dto';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/current-user.decorator';

@Controller('tone')
export class ToneController {
  constructor(private readonly toneService: ToneService) {}

  @Put('samples')
  async saveSamples(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SaveToneSamplesDto,
  ) {
    return this.toneService.saveSamples(user.accountId, dto.samples);
  }

  @Post('profile/rebuild')
  @HttpCode(HttpStatus.OK)
  async rebuildProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() _dto: RebuildToneProfileDto,
  ) {
    const toneProfile = await this.toneService.rebuildProfile(user.accountId);
    return { accountId: user.accountId, toneProfile };
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  async preview(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PreviewToneEmailDto,
  ) {
    return this.toneService.previewStageEmail({
      stage: dto.stage,
      customerName: dto.customerName,
      amountDue: dto.amountDue,
      currency: dto.currency,
      invoiceNumber: dto.invoiceNumber,
      accountId: user.accountId,
    });
  }
}

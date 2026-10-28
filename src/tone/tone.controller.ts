import { Body, Controller, Post, Put, HttpCode, HttpStatus } from '@nestjs/common';
import { ToneService } from './tone.service';
import {
  PreviewToneEmailDto,
  RebuildToneProfileDto,
  SaveToneSamplesDto,
} from './dto/tone.dto';

@Controller('tone')
export class ToneController {
  constructor(private readonly toneService: ToneService) {}

  @Put('samples')
  async saveSamples(@Body() dto: SaveToneSamplesDto) {
    return this.toneService.saveSamples(dto.accountId, dto.samples);
  }

  @Post('profile/rebuild')
  @HttpCode(HttpStatus.OK)
  async rebuildProfile(@Body() dto: RebuildToneProfileDto) {
    const toneProfile = await this.toneService.rebuildProfile(dto.accountId);
    return { accountId: dto.accountId, toneProfile };
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  async preview(@Body() dto: PreviewToneEmailDto) {
    return this.toneService.previewStageEmail(dto);
  }
}
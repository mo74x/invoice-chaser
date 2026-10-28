import {
  Controller,
  Get,
  Put,
  Query,
  Body,
  BadRequestException,
} from '@nestjs/common';
import { SettingsService } from './settings.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  async getSettings(@Query('accountId') accountId: string) {
    if (!accountId) {
      throw new BadRequestException('accountId query parameter is required');
    }
    return this.settingsService.getSettings(accountId);
  }

  @Put()
  async updateSettings(@Body() dto: UpdateSettingsDto) {
    return this.settingsService.updateSettings(dto);
  }
}
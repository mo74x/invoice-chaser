import {
  Controller,
  Get,
  Put,
  Body,
} from '@nestjs/common';
import { SettingsService } from './settings.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/current-user.decorator';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  async getSettings(@CurrentUser() user: AuthenticatedUser) {
    return this.settingsService.getSettings(user.accountId);
  }

  @Put()
  async updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateSettingsDto,
  ) {
    return this.settingsService.updateSettings({
      accountId: user.accountId,
      senderName: dto.senderName,
      senderEmail: dto.senderEmail,
      timezone: dto.timezone,
      approvalMode: dto.approvalMode,
    });
  }
}

import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  BadRequestException,
} from '@nestjs/common';
import { RemindersService } from './reminders.service';

@Controller('reminders')
export class RemindersController {
  constructor(private readonly remindersService: RemindersService) {}

  @Get('pending')
  async getPending(@Query('accountId') accountId: string) {
    if (!accountId) {
      throw new BadRequestException('accountId query parameter is required');
    }
    return this.remindersService.listPending(accountId);
  }

  @Post(':id/approve')
  async approve(@Param('id') id: string) {
    return this.remindersService.approveAndSend(id);
  }

  @Post(':id/skip')
  async skip(@Param('id') id: string) {
    return this.remindersService.skipReminder(id);
  }
}
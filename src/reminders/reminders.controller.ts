import {
  Controller,
  Get,
  Post,
  Param,
} from '@nestjs/common';
import { RemindersService } from './reminders.service';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/current-user.decorator';

@Controller('reminders')
export class RemindersController {
  constructor(private readonly remindersService: RemindersService) {}

  @Get('pending')
  async getPending(@CurrentUser() user: AuthenticatedUser) {
    return this.remindersService.listPending(user.accountId);
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

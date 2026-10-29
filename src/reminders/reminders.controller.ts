import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Body,
} from '@nestjs/common';
import { RemindersService } from './reminders.service';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/current-user.decorator';
import {
  EditReminderDraftDto,
  RejectReminderDto,
} from './dto/reminder-actions.dto';

@Controller('reminders')
export class RemindersController {
  constructor(private readonly remindersService: RemindersService) {}

  @Get('pending')
  async getPending(@CurrentUser() user: AuthenticatedUser) {
    return this.remindersService.listPending(user.accountId);
  }

  @Put(':id/draft')
  async editDraft(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: EditReminderDraftDto,
  ) {
    return this.remindersService.editDraft(id, user.accountId, dto);
  }

  @Post(':id/approve')
  async approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.remindersService.approveAndSend(id, user.accountId);
  }

  @Post(':id/reject')
  async reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RejectReminderDto,
  ) {
    return this.remindersService.rejectReminder(id, user.accountId, dto.reason);
  }

  @Post(':id/skip')
  async skip(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.remindersService.skipReminder(id, user.accountId);
  }

  @Post('invoices/:invoiceId/pause')
  async pauseInvoice(
    @CurrentUser() user: AuthenticatedUser,
    @Param('invoiceId') invoiceId: string,
  ) {
    return this.remindersService.pauseInvoice(invoiceId, user.accountId);
  }

  @Post('customers/:email/pause')
  async pauseCustomer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('email') email: string,
  ) {
    return this.remindersService.pauseCustomer(email, user.accountId);
  }
}

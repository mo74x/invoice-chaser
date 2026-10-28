import {
  Controller,
  Get,
  Query,
  BadRequestException,
} from '@nestjs/common';
import { InvoiceStatus } from '../../generated/prisma/client';
import { InvoicesService } from './invoices.service';

@Controller('invoices')
export class InvoicesController {
  constructor(private readonly invoicesService: InvoicesService) {}

  @Get()
  async list(
    @Query('accountId') accountId: string,
    @Query('status') status?: InvoiceStatus,
  ) {
    if (!accountId) {
      throw new BadRequestException('accountId query parameter is required');
    }
    return this.invoicesService.listInvoices(accountId, status);
  }
}
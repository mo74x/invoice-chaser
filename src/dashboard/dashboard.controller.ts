import {
  Controller,
  Get,
  Query,
  BadRequestException,
} from '@nestjs/common';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('stats')
  async getStats(@Query('accountId') accountId: string) {
    if (!accountId) {
      throw new BadRequestException('accountId query parameter is required');
    }
    return this.dashboardService.getStats(accountId);
  }
}
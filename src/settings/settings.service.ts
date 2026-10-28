import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async getSettings(accountId: string) {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: {
        id: true,
        email: true,
        stripeAccountId: true,
        senderName: true,
        senderEmail: true,
        timezone: true,
        approvalMode: true,
        toneProfile: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!account) {
      throw new NotFoundException(`Account ${accountId} not found`);
    }

    return account;
  }

  async updateSettings(dto: UpdateSettingsDto) {
    if (dto.timezone) {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: dto.timezone });
      } catch {
        throw new BadRequestException(`Invalid IANA timezone: ${dto.timezone}`);
      }
    }

    const existing = await this.prisma.account.findUnique({
      where: { id: dto.accountId },
    });
    if (!existing) {
      throw new NotFoundException(`Account ${dto.accountId} not found`);
    }

    return this.prisma.account.update({
      where: { id: dto.accountId },
      data: {
        ...(dto.senderName !== undefined ? { senderName: dto.senderName } : {}),
        ...(dto.senderEmail !== undefined
          ? { senderEmail: dto.senderEmail }
          : {}),
        ...(dto.timezone !== undefined ? { timezone: dto.timezone } : {}),
        ...(dto.approvalMode !== undefined
          ? { approvalMode: dto.approvalMode }
          : {}),
      },
      select: {
        id: true,
        email: true,
        stripeAccountId: true,
        senderName: true,
        senderEmail: true,
        timezone: true,
        approvalMode: true,
        updatedAt: true,
      },
    });
  }
}
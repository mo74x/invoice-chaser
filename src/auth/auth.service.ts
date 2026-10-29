import {
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async requestMagicLink(email: string): Promise<{ sent: boolean; devMagicLink?: string }> {
    const normalizedEmail = email.toLowerCase().trim();

    // Find or create the account
    const account = await this.prisma.account.upsert({
      where: { email: normalizedEmail },
      create: {
        email: normalizedEmail,
        senderEmail: normalizedEmail,
        senderName: normalizedEmail.split('@')[0],
      },
      update: {},
    });

    const secret = this.configService.getOrThrow<string>('ENCRYPTION_KEY');
    const token = await this.jwtService.signAsync(
      { sub: account.id, email: account.email, purpose: 'magic_link' },
      { secret, expiresIn: '15m' },
    );

    const appUrl = this.configService.getOrThrow<string>('APP_URL');
    const magicLinkUrl = `${appUrl}/auth/verify?token=${token}`;

    this.logger.log(`Magic link requested for ${normalizedEmail}: ${magicLinkUrl}`);

    const isDev = this.configService.get<string>('NODE_ENV') !== 'production';
    return {
      sent: true,
      ...(isDev ? { devMagicLink: magicLinkUrl } : {}),
    };
  }

  async verifyMagicLink(token: string): Promise<{ accessToken: string; accountId: string; email: string }> {
    try {
      const secret = this.configService.getOrThrow<string>('ENCRYPTION_KEY');
      const payload = await this.jwtService.verifyAsync<{ sub: string; email: string; purpose?: string }>(
        token,
        { secret },
      );

      if (payload.purpose !== 'magic_link') {
        throw new UnauthorizedException('Invalid magic link token');
      }

      const accessToken = await this.jwtService.signAsync(
        { sub: payload.sub, email: payload.email },
        { secret, expiresIn: '7d' },
      );

      return {
        accessToken,
        accountId: payload.sub,
        email: payload.email,
      };
    } catch {
      throw new UnauthorizedException('Invalid or expired magic link');
    }
  }
}


import {
  Controller,
  Get,
  Post,
  Param,
  HttpCode,
  HttpStatus,
  Header,
} from '@nestjs/common';
import { MailService } from './mail.service';

@Controller('unsubscribe')
export class MailController {
  constructor(private readonly mailService: MailService) {}

  @Get(':token')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async unsubscribePage(@Param('token') token: string): Promise<string> {
    const { email } = await this.mailService.handleUnsubscribe(token);
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Unsubscribed</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 80vh; margin: 0; color: #111827; }
    .card { max-width: 420px; padding: 32px; border: 1px solid #e5e7eb; border-radius: 12px; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <h2 style="margin-top: 0;">You've been unsubscribed</h2>
    <p style="color: #4b5563; line-height: 1.5;">
      <strong>${email}</strong> will no longer receive automated invoice reminders from this sender.
    </p>
  </div>
</body>
</html>`.trim();
  }

  @Post(':token')
  @HttpCode(HttpStatus.OK)
  async unsubscribeOneClick(@Param('token') token: string) {
    const { email } = await this.mailService.handleUnsubscribe(token);
    return { unsubscribed: true, email };
  }
}
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

@Injectable()
export class MetricsGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const metricsToken = this.configService.get<string>('METRICS_TOKEN');

    // If no token is set in dev, allow internal access. If set, require Bearer token.
    if (!metricsToken) {
      return true;
    }

    const authHeader = request.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${metricsToken}`) {
      throw new UnauthorizedException('Unauthorized access to internal metrics/observability');
    }

    return true;
  }
}


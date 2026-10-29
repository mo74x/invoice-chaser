import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class InboundEmailWebhookDto {
  @IsEmail()
  @IsNotEmpty()
  from!: string;

  @IsEmail()
  @IsNotEmpty()
  to!: string;

  @IsString()
  @IsOptional()
  subject?: string;

  @IsString()
  @IsOptional()
  text?: string;
}


import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class EditReminderDraftDto {
  @IsString()
  @IsOptional()
  subject?: string;

  @IsString()
  @IsNotEmpty()
  body!: string;
}

export class RejectReminderDto {
  @IsString()
  @IsOptional()
  reason?: string;
}


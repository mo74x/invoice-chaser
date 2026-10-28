import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';

export class SaveToneSamplesDto {
  @IsString()
  @IsNotEmpty()
  accountId!: string;

  @IsArray()
  @ArrayMinSize(3, { message: 'Provide at least 3 sample emails' })
  @ArrayMaxSize(5, { message: 'Provide at most 5 sample emails' })
  @IsString({ each: true })
  @MinLength(30, {
    each: true,
    message: 'Each sample email must be at least 30 characters',
  })
  samples!: string[];
}

export class RebuildToneProfileDto {
  @IsString()
  @IsNotEmpty()
  accountId!: string;
}

export class PreviewToneEmailDto {
  @IsString()
  @IsNotEmpty()
  accountId!: string;

  @IsInt()
  @IsIn([3, 7, 14])
  stage!: number;

  @IsOptional()
  @IsString()
  customerName?: string;

  @IsOptional()
  @IsInt()
  @Min(100)
  amountDue?: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsString()
  invoiceNumber?: string;
}
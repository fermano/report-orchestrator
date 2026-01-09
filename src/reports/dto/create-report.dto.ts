import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsObject, IsString, IsUUID, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export enum ReportType {
  USAGE_SUMMARY = 'USAGE_SUMMARY',
  BILLING_EXPORT = 'BILLING_EXPORT',
  AUDIT_SNAPSHOT = 'AUDIT_SNAPSHOT',
}

export enum ReportFormat {
  CSV = 'CSV',
  JSON = 'JSON',
}

export class ReportParamsDto {
  @ApiProperty({ example: '2024-01-01' })
  @IsString()
  from!: string;

  @ApiProperty({ example: '2024-01-31' })
  @IsString()
  to!: string;

  @ApiProperty({ enum: ReportFormat, example: ReportFormat.CSV })
  @IsEnum(ReportFormat)
  format!: ReportFormat;
}

export class CreateReportDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  @IsUUID()
  tenantId!: string;

  @ApiProperty({ enum: ReportType, example: ReportType.USAGE_SUMMARY })
  @IsEnum(ReportType)
  type!: ReportType;

  @ApiProperty({ type: ReportParamsDto })
  @ValidateNested()
  @Type(() => ReportParamsDto)
  @IsObject()
  params!: ReportParamsDto;
}

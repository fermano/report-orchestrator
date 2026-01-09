import { ApiProperty } from '@nestjs/swagger';

export enum ReportStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

export class ReportResponseDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  id!: string;

  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  tenantId!: string;

  @ApiProperty({ example: 'USAGE_SUMMARY' })
  type!: string;

  @ApiProperty()
  params!: Record<string, any>;

  @ApiProperty({ enum: ReportStatus, example: ReportStatus.PENDING })
  status!: ReportStatus;

  @ApiProperty({ example: 0 })
  attempts!: number;

  @ApiProperty({ required: false })
  idempotencyKey?: string;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;

  @ApiProperty({ required: false })
  artifact?: {
    id: string;
    contentType: string;
    sizeBytes: number;
    checksum: string;
    createdAt: Date;
  };
}

import { Injectable, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateReportDto } from '../../reports/dto/create-report.dto';
import { ReportResponseDto, ReportStatus } from '../../reports/dto/report-response.dto';

@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Handles idempotent report creation. This is purely infrastructure - the business
   * service knows nothing about idempotency keys.
   */
  async findOrCreateReport(
    createReportDto: CreateReportDto,
    idempotencyKey: string | undefined,
    businessCreateFn: () => Promise<ReportResponseDto>,
  ): Promise<{ result: ReportResponseDto; created: boolean }> {
    // If no idempotency key, just use business service
    if (!idempotencyKey) {
      const result = await businessCreateFn();
      return { result, created: true };
    }

    // Check for existing report with this key
    const existing = await this.findReportByKey(idempotencyKey);
    if (existing) {
      return { result: existing, created: false };
    }

    // Try to create with idempotency key stored
    try {
      const report = await this.prisma.report.create({
        data: {
          tenantId: createReportDto.tenantId,
          type: createReportDto.type,
          params: createReportDto.params as any,
          status: ReportStatus.PENDING,
          idempotencyKey,
        },
        include: { artifacts: true },
      });

      return { result: this.mapToResponseDto(report), created: true };
    } catch (error: any) {
      // Handle race condition: another request created report with same key
      if (error.code === 'P2002' && error.meta?.target?.includes('idempotency_key')) {
        const existing = await this.findReportByKey(idempotencyKey);
        if (existing) {
          return { result: existing, created: false };
        }
        throw new ConflictException(
          'Failed to create report: idempotency key conflict could not be resolved',
        );
      }
      throw error;
    }
  }

  private async findReportByKey(idempotencyKey: string): Promise<ReportResponseDto | null> {
    const report = await this.prisma.report.findUnique({
      where: { idempotencyKey },
      include: { artifacts: true },
    });

    return report ? this.mapToResponseDto(report) : null;
  }

  private mapToResponseDto(report: any): ReportResponseDto {
    return {
      id: report.id,
      tenantId: report.tenantId,
      type: report.type,
      params: report.params as Record<string, any>,
      status: report.status as ReportStatus,
      attempts: report.attempts,
      idempotencyKey: report.idempotencyKey || undefined,
      createdAt: report.createdAt,
      updatedAt: report.updatedAt,
      artifact:
        report.artifacts && report.artifacts.length > 0
          ? {
              id: report.artifacts[0].id,
              contentType: report.artifacts[0].contentType,
              sizeBytes: report.artifacts[0].sizeBytes,
              checksum: report.artifacts[0].checksum,
              createdAt: report.artifacts[0].createdAt,
            }
          : undefined,
    };
  }
}

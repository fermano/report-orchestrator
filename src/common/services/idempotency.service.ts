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
   * 
   * Priority:
   * 1. Idempotency-Key match (infrastructure concern - request deduplication)
   * 2. Semantic match (business concern - handled by ReportsService)
   * 3. Create new
   */
  async findOrCreateReport(
    createReportDto: CreateReportDto,
    idempotencyKey: string | undefined,
    businessCreateFn: () => Promise<ReportResponseDto>,
  ): Promise<{ result: ReportResponseDto; created: boolean }> {
    // Priority 1: Check for existing report with this idempotency key
    if (idempotencyKey) {
      const existingByKey = await this.findReportByKey(idempotencyKey);
      if (existingByKey) {
        return { result: existingByKey, created: false };
      }
    }

    // Priority 2: Use business service (which handles semantic deduplication)
    // Business service will check for existing COMPLETED reports with same semantics
    // and return that, or create a new one
    const result = await businessCreateFn();

    // If we have an idempotency key, try to set it on the report
    // (whether it was found semantically or newly created)
    if (idempotencyKey && !result.idempotencyKey) {
      try {
        await this.prisma.report.update({
          where: { id: result.id },
          data: { idempotencyKey },
        });
        // Re-fetch to get updated result
        const updated = await this.findReportByKey(idempotencyKey);
        if (updated) {
          return { result: updated, created: result.status === 'PENDING' };
        }
      } catch (error: any) {
        // Handle race condition: another request set the key
        if (error.code === 'P2002' && error.meta?.target?.includes('idempotency_key')) {
          const existing = await this.findReportByKey(idempotencyKey);
          if (existing) {
            return { result: existing, created: false };
          }
        }
        // If update fails for other reasons, return the result without key
      }
    }

    // Determine if report was created (PENDING status) or found (COMPLETED status)
    const wasCreated = result.status === ReportStatus.PENDING;
    return { result, created: wasCreated };
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

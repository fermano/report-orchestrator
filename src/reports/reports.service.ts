import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateReportDto } from './dto/create-report.dto';
import { ReportResponseDto, ReportStatus } from './dto/report-response.dto';

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates a new report. Pure business operation.
   * Implements semantic deduplication:
   * - Reuses existing COMPLETED reports with the same tenant/type/params
   * - Optionally reuses RUNNING reports (to avoid duplicate in-progress work)
   * - Allows multiple PENDING reports (they'll naturally converge when one completes)
   * 
   * Priority order:
   * 1. COMPLETED reports (reuse existing results - most important)
   * 2. RUNNING reports (reuse in-progress work - optional optimization)
   * 3. Create new PENDING report (if no COMPLETED/RUNNING exists)
   * 
   * What happens to concurrent "racers":
   * - Multiple concurrent requests can create multiple PENDING reports
   * - Workers process them independently
   * - When they try to create artifacts, unique constraint on report_artifacts.report_id
   *   ensures only one artifact is created
   * - Workers converge duplicate attempts to COMPLETED state
   * - Future requests will find the COMPLETED report and return it
   */
  async create(createReportDto: CreateReportDto): Promise<ReportResponseDto> {
    // Check for existing COMPLETED report first (most important - reuse results)
    // Also check for RUNNING to avoid duplicate in-progress work
    const existing = await this.findExistingSemanticReport(
      createReportDto.tenantId,
      createReportDto.type,
      createReportDto.params,
    );

    if (existing) {
      // Return existing COMPLETED or RUNNING report
      return this.mapToResponseDto(existing);
    }

    // No existing COMPLETED/RUNNING report found, create new PENDING report
    // Multiple concurrent requests may create multiple PENDING reports - that's fine
    // They'll converge naturally when one completes
    const report = await this.prisma.report.create({
      data: {
        tenantId: createReportDto.tenantId,
        type: createReportDto.type,
        params: createReportDto.params as any,
        status: ReportStatus.PENDING,
      },
      include: { artifacts: true },
    });

    return this.mapToResponseDto(report);
  }

  /**
   * Finds an existing COMPLETED or RUNNING report with the same business semantics
   * (tenantId, type, params). Returns the most recent COMPLETED, or oldest RUNNING if no COMPLETED exists.
   * 
   * Does NOT check for PENDING reports - we allow multiple PENDING reports to be created.
   * They will converge naturally when one completes.
   */
  private async findExistingSemanticReport(
    tenantId: string,
    type: string,
    params: any,
  ): Promise<any | null> {
    // Check for COMPLETED or RUNNING reports (not PENDING)
    // Priority: COMPLETED > RUNNING
    const report = await this.prisma.$queryRaw<any[]>`
      SELECT * FROM reports
      WHERE tenant_id = ${tenantId}
        AND type = ${type}
        AND params = ${JSON.stringify(params)}::jsonb
        AND status IN ('COMPLETED', 'RUNNING')
      ORDER BY 
        CASE status 
          WHEN 'COMPLETED' THEN 1  -- Prefer COMPLETED first
          WHEN 'RUNNING' THEN 2    -- Then RUNNING
        END,
        created_at DESC  -- Prefer most recent COMPLETED, oldest RUNNING
      LIMIT 1
    `;

    if (!report || report.length === 0) {
      return null;
    }

    // Fetch full report with relations
    return await this.prisma.report.findUnique({
      where: { id: report[0].id },
      include: { artifacts: true },
    });
  }

  async findOne(id: string): Promise<ReportResponseDto> {
    const report = await this.prisma.report.findUnique({
      where: { id },
      include: { artifacts: true },
    });

    if (!report) {
      throw new NotFoundException(`Report with ID ${id} not found`);
    }

    return this.mapToResponseDto(report);
  }

  async findByTenant(
    tenantId: string,
    status?: ReportStatus,
    type?: string,
    limit: number = 20,
    cursor?: string,
  ): Promise<{ reports: ReportResponseDto[]; nextCursor?: string }> {
    const where: any = { tenantId };
    if (status) {
      where.status = status;
    }
    if (type) {
      where.type = type;
    }
    if (cursor) {
      where.id = { gt: cursor };
    }

    const reports = await this.prisma.report.findMany({
      where,
      take: limit + 1,
      orderBy: { createdAt: 'desc' },
      include: { artifacts: true },
    });

    const hasNext = reports.length > limit;
    const results = hasNext ? reports.slice(0, limit) : reports;

    return {
      reports: results.map((r) => this.mapToResponseDto(r)),
      nextCursor: hasNext ? results[results.length - 1].id : undefined,
    };
  }

  async getArtifact(reportId: string): Promise<{ content: Buffer; contentType: string }> {
    const report = await this.prisma.report.findUnique({
      where: { id: reportId },
      include: { artifacts: true },
    });

    if (!report) {
      throw new NotFoundException(`Report with ID ${reportId} not found`);
    }

    if (report.status !== ReportStatus.COMPLETED) {
      throw new ConflictException(
        `Report is not completed. Current status: ${report.status}`,
      );
    }

    if (!report.artifacts || report.artifacts.length === 0) {
      throw new NotFoundException(`Artifact not found for report ${reportId}`);
    }

    const artifact = report.artifacts[0];
    return {
      content: Buffer.from(artifact.content),
      contentType: artifact.contentType,
    };
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

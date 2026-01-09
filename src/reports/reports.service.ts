import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateReportDto } from './dto/create-report.dto';
import { ReportResponseDto, ReportStatus } from './dto/report-response.dto';

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates a new report. Pure business operation.
   */
  async create(createReportDto: CreateReportDto): Promise<ReportResponseDto> {
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

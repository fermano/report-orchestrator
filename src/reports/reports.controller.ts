import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Res,
  HttpCode,
  HttpStatus,
  Headers,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiHeader, ApiParam, ApiQuery } from '@nestjs/swagger';
import { Response } from 'express';
import { ReportsService } from './reports.service';
import { IdempotencyService } from '../common/services/idempotency.service';
import { CreateReportDto } from './dto/create-report.dto';
import { ReportResponseDto } from './dto/report-response.dto';
import { ListReportsQueryDto } from './dto/list-reports-query.dto';

@ApiTags('reports')
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reportsService: ReportsService,
    private readonly idempotencyService: IdempotencyService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a new report job' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Optional idempotency key for duplicate request prevention',
  })
  @ApiResponse({ status: 201, description: 'Report created', type: ReportResponseDto })
  @ApiResponse({ status: 200, description: 'Report already exists (idempotent)', type: ReportResponseDto })
  async create(
    @Body() createReportDto: CreateReportDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReportResponseDto> {
    const { result, created } = await this.idempotencyService.findOrCreateReport(
      createReportDto,
      idempotencyKey,
      () => this.reportsService.create(createReportDto),
    );

    // Set appropriate status code: 201 for created, 200 for existing
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);

    return result;
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get report status by ID' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Report found', type: ReportResponseDto })
  @ApiResponse({ status: 404, description: 'Report not found' })
  async findOne(@Param('id') id: string): Promise<ReportResponseDto> {
    return this.reportsService.findOne(id);
  }

  @Get(':id/download')
  @ApiOperation({ summary: 'Download report artifact' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Artifact downloaded' })
  @ApiResponse({ status: 404, description: 'Report or artifact not found' })
  @ApiResponse({ status: 409, description: 'Report not completed' })
  async download(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const { content, contentType } = await this.reportsService.getArtifact(id);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="report-${id}"`);
    res.send(content);
  }
}

@ApiTags('tenants')
@Controller('tenants')
export class TenantsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get(':tenantId/reports')
  @ApiOperation({ summary: 'List reports by tenant' })
  @ApiParam({ name: 'tenantId', type: 'string', format: 'uuid' })
  @ApiQuery({ name: 'status', required: false, enum: ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED'] })
  @ApiQuery({ name: 'type', required: false, enum: ['USAGE_SUMMARY', 'BILLING_EXPORT', 'AUDIT_SNAPSHOT'] })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Reports listed' })
  async listReports(
    @Param('tenantId') tenantId: string,
    @Query() query: ListReportsQueryDto,
  ) {
    return this.reportsService.findByTenant(
      tenantId,
      query.status,
      query.type,
      query.limit,
      query.cursor,
    );
  }
}

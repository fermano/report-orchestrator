import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { PinoLogger } from 'nestjs-pino';
import { ReportType } from './dto/create-report.dto';
import { ReportStatus } from './dto/report-response.dto';
import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class ReportWorkerService implements OnModuleInit, OnModuleDestroy {
  private isRunning = false;
  private pollInterval?: NodeJS.Timeout;
  private readonly pollIntervalMs: number;
  private readonly staleLockTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly instanceId: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.pollIntervalMs = this.configService.get<number>('WORKER_POLL_INTERVAL_MS', 5000);
    this.staleLockTimeoutMs = this.configService.get<number>(
      'WORKER_STALE_LOCK_TIMEOUT_MS',
      300000,
    );
    this.maxAttempts = this.configService.get<number>('WORKER_MAX_ATTEMPTS', 3);
    this.instanceId =
      this.configService.get<string>('WORKER_INSTANCE_ID') || `worker-${uuidv4()}`;
  }

  onModuleInit() {
    this.logger.info({ instanceId: this.instanceId }, 'Report worker service initialized');
    // Worker is started manually via worker.ts entrypoint
  }

  onModuleDestroy() {
    this.stop();
  }

  async start() {
    if (this.isRunning) {
      this.logger.warn('Worker is already running');
      return;
    }

    this.isRunning = true;
    this.logger.info(
      {
        instanceId: this.instanceId,
        pollIntervalMs: this.pollIntervalMs,
        staleLockTimeoutMs: this.staleLockTimeoutMs,
        maxAttempts: this.maxAttempts,
      },
      'Starting report worker',
    );

    // Initial recovery of stale locks
    await this.recoverStaleLocks();

    // Start polling
    this.pollInterval = setInterval(() => {
      this.processNextJob().catch((error) => {
        this.logger.error({ error }, 'Error in worker poll cycle');
      });
    }, this.pollIntervalMs);
  }

  stop() {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }
    this.logger.info({ instanceId: this.instanceId }, 'Report worker stopped');
  }

  private async recoverStaleLocks() {
    const staleThreshold = new Date(Date.now() - this.staleLockTimeoutMs);

    const result = await this.prisma.report.updateMany({
      where: {
        status: ReportStatus.RUNNING,
        lockedAt: {
          lt: staleThreshold,
        },
      },
      data: {
        status: ReportStatus.PENDING,
        lockedAt: null,
        lockedBy: null,
      },
    });

    if (result.count > 0) {
      this.logger.info(
        { count: result.count, instanceId: this.instanceId },
        'Recovered stale locks',
      );
    }
  }

  // Exposed for testing
  async processNextJob() {
    try {
      // Recover stale locks periodically (every 10 cycles)
      if (Math.random() < 0.1) {
        await this.recoverStaleLocks();
      }

      // Claim a PENDING job using atomic UPDATE with SKIP LOCKED pattern
      const report = await this.claimNextJob();

      if (!report) {
        return; // No work available
      }

      this.logger.info(
        { reportId: report.id, instanceId: this.instanceId },
        'Claimed report job',
      );

      // Create execution record
      const execution = await this.prisma.reportExecution.create({
        data: {
          reportId: report.id,
          attempt: report.attempts + 1,
          startedAt: new Date(),
        },
      });

      try {
        // Generate report artifact
        const artifact = await this.generateReport(report);

        // Try to insert artifact (this enforces exactly-once via UNIQUE constraint)
        try {
          await this.prisma.reportArtifact.create({
            data: {
              reportId: report.id,
              contentType: artifact.contentType,
              content: artifact.content,
              sizeBytes: artifact.sizeBytes,
              checksum: artifact.checksum,
            },
          });

          // Mark report as completed
          await this.prisma.report.update({
            where: { id: report.id },
            data: {
              status: ReportStatus.COMPLETED,
              attempts: report.attempts + 1,
              lockedAt: null,
              lockedBy: null,
            },
          });

          await this.prisma.reportExecution.update({
            where: { id: execution.id },
            data: { finishedAt: new Date() },
          });

          this.logger.info(
            {
              reportId: report.id,
              instanceId: this.instanceId,
              attempt: report.attempts + 1,
            },
            'Report completed successfully',
          );
        } catch (error: any) {
          // Handle unique constraint violation (artifact already exists)
          if (error.code === 'P2002' && error.meta?.target?.includes('report_id')) {
            this.logger.warn(
              { reportId: report.id, instanceId: this.instanceId },
              'Artifact already exists, converging to COMPLETED',
            );

            // Another worker already created the artifact, converge state
            await this.prisma.report.update({
              where: { id: report.id },
              data: {
                status: ReportStatus.COMPLETED,
                lockedAt: null,
                lockedBy: null,
              },
            });

            await this.prisma.reportExecution.update({
              where: { id: execution.id },
              data: { finishedAt: new Date() },
            });
          } else {
            throw error;
          }
        }
      } catch (error: any) {
        // Handle execution failure
        const newAttempts = report.attempts + 1;
        const shouldRetry = newAttempts < this.maxAttempts;

        await this.prisma.report.update({
          where: { id: report.id },
          data: {
            status: shouldRetry ? ReportStatus.PENDING : ReportStatus.FAILED,
            attempts: newAttempts,
            lockedAt: null,
            lockedBy: null,
          },
        });

        await this.prisma.reportExecution.update({
          where: { id: execution.id },
          data: {
            finishedAt: new Date(),
            error: error.message || String(error),
          },
        });

        this.logger.error(
          {
            reportId: report.id,
            instanceId: this.instanceId,
            attempt: newAttempts,
            error: error.message,
            willRetry: shouldRetry,
          },
          'Report execution failed',
        );
      }
    } catch (error) {
      this.logger.error({ error, instanceId: this.instanceId }, 'Unexpected error in worker');
    }
  }

  private async claimNextJob() {
    // Use a transaction with SELECT FOR UPDATE SKIP LOCKED to safely claim a job
    return await this.prisma.$transaction(async (tx) => {
      // First, find a PENDING job that's not locked or has a stale lock
      const staleThreshold = new Date(Date.now() - this.staleLockTimeoutMs);

      const candidates = await tx.$queryRaw<Array<{
        id: string;
        tenant_id: string;
        type: string;
        params: any;
        status: string;
        attempts: number;
        locked_at: Date | null;
        locked_by: string | null;
      }>>`
        SELECT * FROM reports
        WHERE status = 'PENDING'
          AND (locked_at IS NULL OR locked_at < ${staleThreshold})
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;

      if (!candidates || candidates.length === 0) {
        return null;
      }

      const report = candidates[0];

      // Update to RUNNING and lock it
      await tx.report.update({
        where: { id: report.id },
        data: {
          status: ReportStatus.RUNNING,
          lockedAt: new Date(),
          lockedBy: this.instanceId,
        },
      });

      return {
        id: report.id,
        tenantId: report.tenant_id,
        type: report.type,
        params: report.params,
        status: report.status,
        attempts: report.attempts,
      };
    });
  }

  private async generateReport(report: {
    id: string;
    tenantId: string;
    type: string;
    params: any;
  }): Promise<{
    content: Buffer;
    contentType: string;
    sizeBytes: number;
    checksum: string;
  }> {
    // Simulate compute-heavy work
    const delay = Math.random() * 1000 + 500; // 500-1500ms
    await new Promise((resolve) => setTimeout(resolve, delay));

    // Generate deterministic content based on params
    const { from, to, format } = report.params;
    const content = this.generateReportContent(report.type, from, to, format);

    const buffer = Buffer.from(content, 'utf-8');
    const checksum = createHash('sha256').update(buffer).digest('hex');

    return {
      content: buffer,
      contentType: format === 'CSV' ? 'text/csv' : 'application/json',
      sizeBytes: buffer.length,
      checksum,
    };
  }

  private generateReportContent(
    type: string,
    from: string,
    to: string,
    format: string,
  ): string {
    const baseData = {
      type,
      from,
      to,
      generatedAt: new Date().toISOString(),
    };

    if (format === 'CSV') {
      // Generate CSV content
      const rows = [
        ['Type', 'From', 'To', 'Generated At'],
        [type, from, to, baseData.generatedAt],
      ];

      // Add some sample data rows
      for (let i = 0; i < 10; i++) {
        rows.push([
          `Row ${i + 1}`,
          `Data ${i + 1}`,
          `Value ${i + 1}`,
          new Date().toISOString(),
        ]);
      }

      return rows.map((row) => row.join(',')).join('\n');
    } else {
      // Generate JSON content
      return JSON.stringify(
        {
          ...baseData,
          data: Array.from({ length: 10 }, (_, i) => ({
            id: i + 1,
            name: `Item ${i + 1}`,
            value: Math.random() * 100,
          })),
        },
        null,
        2,
      );
    }
  }
}

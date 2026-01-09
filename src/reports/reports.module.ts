import { Module } from '@nestjs/common';
import { ReportsController, TenantsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { ReportWorkerService } from './report-worker.service';
import { IdempotencyService } from '../common/services/idempotency.service';

@Module({
  controllers: [ReportsController, TenantsController],
  providers: [ReportsService, ReportWorkerService, IdempotencyService],
  exports: [ReportsService],
})
export class ReportsModule {}

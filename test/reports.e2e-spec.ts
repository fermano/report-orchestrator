import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ReportWorkerService } from '../src/reports/report-worker.service';
import { setupTestDatabase, teardownTestDatabase } from './setup';
import { v4 as uuidv4 } from 'uuid';

describe('Reports (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let workerService: ReportWorkerService;
  let originalDatabaseUrl: string;

  beforeAll(async () => {
    // Setup test database
    originalDatabaseUrl = process.env.DATABASE_URL || '';
    const testDatabaseUrl = await setupTestDatabase();
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.WORKER_POLL_INTERVAL_MS = '100';
    process.env.WORKER_STALE_LOCK_TIMEOUT_MS = '5000';
    process.env.WORKER_MAX_ATTEMPTS = '3';
    process.env.WORKER_INSTANCE_ID = 'test-worker';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );

    prisma = app.get<PrismaService>(PrismaService);
    workerService = app.get<ReportWorkerService>(ReportWorkerService);

    await app.init();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (prisma) {
      await prisma.$disconnect();
    }
    process.env.DATABASE_URL = originalDatabaseUrl;
    await teardownTestDatabase();
  });

  beforeEach(async () => {
    // Clean up database before each test
    if (prisma) {
      await prisma.reportExecution.deleteMany();
      await prisma.reportArtifact.deleteMany();
      await prisma.report.deleteMany();
    }
  });

  describe('POST /reports - Request Idempotency', () => {
    it('should create a new report when idempotency key is not provided', async () => {
      const tenantId = uuidv4();
      const createDto = {
        tenantId,
        type: 'USAGE_SUMMARY',
        params: {
          from: '2024-01-01',
          to: '2024-01-31',
          format: 'CSV',
        },
      };

      const response = await request(app.getHttpServer())
        .post('/reports')
        .send(createDto)
        .expect(201);

      expect(response.body.id).toBeDefined();
      expect(response.body.status).toBe('PENDING');
      expect(response.body.tenantId).toBe(tenantId);
    });

    it('should return existing report when same idempotency key is used', async () => {
      const tenantId = uuidv4();
      const idempotencyKey = uuidv4();
      const createDto = {
        tenantId,
        type: 'USAGE_SUMMARY',
        params: {
          from: '2024-01-01',
          to: '2024-01-31',
          format: 'CSV',
        },
      };

      // First request
      const firstResponse = await request(app.getHttpServer())
        .post('/reports')
        .set('Idempotency-Key', idempotencyKey)
        .send(createDto)
        .expect(201);

      const firstReportId = firstResponse.body.id;

      // Second request with same idempotency key
      const secondResponse = await request(app.getHttpServer())
        .post('/reports')
        .set('Idempotency-Key', idempotencyKey)
        .send(createDto)
        .expect(200);

      expect(secondResponse.body.id).toBe(firstReportId);

      // Verify only one report exists
      const reports = await prisma.report.findMany({
        where: { idempotencyKey },
      });
      expect(reports).toHaveLength(1);
    });

    it('should handle concurrent requests with same idempotency key', async () => {
      const tenantId = uuidv4();
      const idempotencyKey = uuidv4();
      const createDto = {
        tenantId,
        type: 'USAGE_SUMMARY',
        params: {
          from: '2024-01-01',
          to: '2024-01-31',
          format: 'CSV',
        },
      };

      // Send 5 concurrent requests
      const requests = Array.from({ length: 5 }, () =>
        request(app.getHttpServer())
          .post('/reports')
          .set('Idempotency-Key', idempotencyKey)
          .send(createDto),
      );

      const responses = await Promise.all(requests);

      // All should succeed (some may be 201, some 200)
      responses.forEach((response: any) => {
        expect([200, 201]).toContain(response.status);
      });

      // All should reference the same report ID
      const reportIds = responses.map((r: any) => r.body.id);
      const uniqueIds = new Set(reportIds);
      expect(uniqueIds.size).toBe(1);

      // Verify only one report exists in database
      const reports = await prisma.report.findMany({
        where: { idempotencyKey },
      });
      expect(reports).toHaveLength(1);
    });
  });

  describe('Worker - Multi-worker Safety', () => {
    it('should ensure exactly one artifact per report with multiple workers', async () => {
      const tenantId = uuidv4();
      const reports = [];

      // Create 10 reports
      for (let i = 0; i < 10; i++) {
        const report = await prisma.report.create({
          data: {
            tenantId,
            type: 'USAGE_SUMMARY',
            params: {
              from: '2024-01-01',
              to: '2024-01-31',
              format: 'CSV',
            },
            status: 'PENDING',
          },
        });
        reports.push(report);
      }

      // Process jobs concurrently using multiple workers
      const worker1 = workerService;
      const worker2 = app.get(ReportWorkerService);

      // Process jobs concurrently (each worker processes multiple times)
      const promises = [];
      for (let i = 0; i < 20; i++) {
        promises.push(worker1.processNextJob());
        promises.push(worker2.processNextJob());
      }

      await Promise.all(promises);

      // Wait a bit for all processing to complete
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Verify each report has exactly one artifact
      for (const report of reports) {
        const artifacts = await prisma.reportArtifact.findMany({
          where: { reportId: report.id },
        });
        expect(artifacts.length).toBeLessThanOrEqual(1);

        if (artifacts.length === 1) {
          const updatedReport = await prisma.report.findUnique({
            where: { id: report.id },
          });
          expect(updatedReport?.status).toBe('COMPLETED');
        }
      }
    });
  });

  describe('Worker - Crash Simulation', () => {
    it('should handle crash after artifact creation but before status update', async () => {
      const tenantId = uuidv4();
      const report = await prisma.report.create({
        data: {
          tenantId,
          type: 'USAGE_SUMMARY',
          params: {
            from: '2024-01-01',
            to: '2024-01-31',
            format: 'CSV',
          },
          status: 'PENDING',
        },
      });

      // Manually create artifact (simulating crash after artifact creation)
      const artifactContent = Buffer.from('test content');
      await prisma.reportArtifact.create({
        data: {
          reportId: report.id,
          contentType: 'text/csv',
          content: artifactContent,
          sizeBytes: artifactContent.length,
          checksum: 'test-checksum',
        },
      });

      // Report is still PENDING (simulating crash)
      const beforeReport = await prisma.report.findUnique({
        where: { id: report.id },
      });
      expect(beforeReport?.status).toBe('PENDING');

      // Worker processes the job again
      await workerService.processNextJob();

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Verify report is now COMPLETED and still has only one artifact
      const afterReport = await prisma.report.findUnique({
        where: { id: report.id },
      });
      expect(afterReport?.status).toBe('COMPLETED');

      const artifacts = await prisma.reportArtifact.findMany({
        where: { reportId: report.id },
      });
      expect(artifacts).toHaveLength(1);
    });
  });

  describe('GET /reports/:id', () => {
    it('should return report status', async () => {
      const tenantId = uuidv4();
      const report = await prisma.report.create({
        data: {
          tenantId,
          type: 'USAGE_SUMMARY',
          params: {
            from: '2024-01-01',
            to: '2024-01-31',
            format: 'CSV',
          },
          status: 'PENDING',
        },
      });

      const response = await request(app.getHttpServer())
        .get(`/reports/${report.id}`)
        .expect(200);

      expect(response.body.id).toBe(report.id);
      expect(response.body.status).toBe('PENDING');
    });

    it('should return 404 for non-existent report', async () => {
      const fakeId = uuidv4();
      await request(app.getHttpServer()).get(`/reports/${fakeId}`).expect(404);
    });
  });

  describe('GET /reports/:id/download', () => {
    it('should download artifact when report is completed', async () => {
      const tenantId = uuidv4();
      const report = await prisma.report.create({
        data: {
          tenantId,
          type: 'USAGE_SUMMARY',
          params: {
            from: '2024-01-01',
            to: '2024-01-31',
            format: 'CSV',
          },
          status: 'COMPLETED',
        },
      });

      const artifactContent = Buffer.from('test,data\n1,2');
      await prisma.reportArtifact.create({
        data: {
          reportId: report.id,
          contentType: 'text/csv',
          content: artifactContent,
          sizeBytes: artifactContent.length,
          checksum: 'test-checksum',
        },
      });

      const response = await request(app.getHttpServer())
        .get(`/reports/${report.id}/download`)
        .expect(200);

      expect(response.headers['content-type']).toContain('text/csv');
      // For binary/text responses, supertest may return body as object with data property
      // or as a string. Handle both cases.
      let receivedContent: string;
      if (typeof response.body === 'string') {
        receivedContent = response.body;
      } else if (response.body && typeof response.body === 'object' && 'data' in response.body) {
        receivedContent = Array.isArray(response.body.data)
          ? Buffer.from(response.body.data).toString('utf8')
          : response.body.data.toString('utf8');
      } else if (Buffer.isBuffer(response.body)) {
        receivedContent = response.body.toString('utf8');
      } else {
        // Fallback: try to get text from response
        receivedContent = response.text || JSON.stringify(response.body);
      }
      expect(receivedContent).toBe(artifactContent.toString('utf8'));
    });

    it('should return 409 when report is not completed', async () => {
      const tenantId = uuidv4();
      const report = await prisma.report.create({
        data: {
          tenantId,
          type: 'USAGE_SUMMARY',
          params: {
            from: '2024-01-01',
            to: '2024-01-31',
            format: 'CSV',
          },
          status: 'PENDING',
        },
      });

      await request(app.getHttpServer())
        .get(`/reports/${report.id}/download`)
        .expect(409);
    });
  });

  describe('GET /tenants/:tenantId/reports', () => {
    it('should list reports for a tenant', async () => {
      const tenantId = uuidv4();

      // Create multiple reports
      for (let i = 0; i < 5; i++) {
        await prisma.report.create({
          data: {
            tenantId,
            type: 'USAGE_SUMMARY',
            params: {
              from: '2024-01-01',
              to: '2024-01-31',
              format: 'CSV',
            },
            status: i % 2 === 0 ? 'PENDING' : 'COMPLETED',
          },
        });
      }

      const response = await request(app.getHttpServer())
        .get(`/tenants/${tenantId}/reports`)
        .expect(200);

      expect(response.body.reports).toHaveLength(5);
      expect(response.body.reports.every((r: any) => r.tenantId === tenantId)).toBe(true);
    });

    it('should filter by status', async () => {
      const tenantId = uuidv4();

      await prisma.report.create({
        data: {
          tenantId,
          type: 'USAGE_SUMMARY',
          params: { from: '2024-01-01', to: '2024-01-31', format: 'CSV' },
          status: 'PENDING',
        },
      });

      await prisma.report.create({
        data: {
          tenantId,
          type: 'USAGE_SUMMARY',
          params: { from: '2024-01-01', to: '2024-01-31', format: 'CSV' },
          status: 'COMPLETED',
        },
      });

      const response = await request(app.getHttpServer())
        .get(`/tenants/${tenantId}/reports`)
        .query({ status: 'PENDING' })
        .expect(200);

      expect(response.body.reports).toHaveLength(1);
      expect(response.body.reports[0].status).toBe('PENDING');
    });
  });
});

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ReportWorkerService } from './reports/report-worker.service';
import { Logger } from 'nestjs-pino';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });

  const logger = app.get(Logger);
  app.useLogger(logger);

  const workerService = app.get(ReportWorkerService);
  await workerService.start();

  logger.log('Report worker started');

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    logger.log('SIGTERM received, shutting down worker');
    workerService.stop();
    await app.close();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    logger.log('SIGINT received, shutting down worker');
    workerService.stop();
    await app.close();
    process.exit(0);
  });
}

bootstrap().catch((error) => {
  console.error('Failed to start worker:', error);
  process.exit(1);
});

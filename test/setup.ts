import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

let container: StartedPostgreSqlContainer | null = null;
let databaseUrl: string;
let useExistingDatabase = false;

export async function setupTestDatabase(): Promise<string> {
  // Check if we should use existing database (from docker-compose or .env)
  const useExisting = process.env.USE_EXISTING_DB === 'true' || process.env.DATABASE_URL;

  if (useExisting && process.env.DATABASE_URL) {
    // Use existing database connection
    console.log('Using existing database from DATABASE_URL');
    databaseUrl = process.env.DATABASE_URL;
    useExistingDatabase = true;

    // Run Prisma migrations on existing database
    await execAsync('npx prisma migrate deploy', {
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });

    return databaseUrl;
  }

  // Try to use testcontainers
  try {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('test_db')
      .withUsername('test_user')
      .withPassword('test_password')
      .start();

    databaseUrl = container.getConnectionUri();

    // Run Prisma migrations
    process.env.DATABASE_URL = databaseUrl;
    await execAsync('npx prisma migrate deploy', {
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });

    return databaseUrl;
  } catch (error: any) {
    if (error.message?.includes('container runtime') || error.message?.includes('Docker')) {
      // Fallback to existing database if available
      const fallbackUrl = process.env.DATABASE_URL;
      if (fallbackUrl) {
        console.warn(
          '⚠️  Testcontainers unavailable. Falling back to existing database from DATABASE_URL.',
        );
        console.warn('⚠️  Note: Tests will use the same database - ensure it is safe to modify.');
        databaseUrl = fallbackUrl;
        useExistingDatabase = true;

        // Run Prisma migrations on existing database
        await execAsync('npx prisma migrate deploy', {
          env: { ...process.env, DATABASE_URL: databaseUrl },
        });

        return databaseUrl;
      }

      throw new Error(
        'Docker is required to run tests. Please ensure Docker is installed and running. ' +
          'You can start Docker with: docker-compose up -d\n' +
          'Alternatively, set USE_EXISTING_DB=true to use the database from DATABASE_URL.',
      );
    }
    throw error;
  }
}

export async function teardownTestDatabase(): Promise<void> {
  // Only stop container if we created it (not using existing database)
  if (container && !useExistingDatabase) {
    try {
      await container.stop();
    } catch (error) {
      // Ignore errors during teardown
    }
  }
}

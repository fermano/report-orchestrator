# Report Orchestrator

A production-quality NestJS + TypeScript service for asynchronous, idempotent report generation designed for multi-instance (Kubernetes) execution.

## Overview

This service provides a robust backend for generating reports asynchronously with strong guarantees:

- **Request-level idempotency**: Duplicate client requests with the same `Idempotency-Key` return the same report job
- **Execution-level idempotency**: Exactly-once report artifact creation, even with retries, crashes, or multiple workers
- **Multi-instance safe**: Uses database-level locking to safely coordinate work across multiple worker instances

## Architecture

### Components

1. **API Server** (`main.ts`): REST API for creating and querying reports
2. **Worker Service** (`worker.ts`): Background worker that processes pending reports
3. **Database**: PostgreSQL with Prisma ORM for persistence

### State Machine

Reports progress through the following states:

```
PENDING → RUNNING → COMPLETED
              ↓
           FAILED (after max attempts)
```

- **PENDING**: Report job created, waiting for worker
- **RUNNING**: Worker has claimed the job and is generating the report
- **COMPLETED**: Report generated successfully, artifact available
- **FAILED**: Report generation failed after maximum retry attempts

### Job Claiming Mechanism

The worker uses PostgreSQL's `SELECT ... FOR UPDATE SKIP LOCKED` pattern to safely claim jobs:

1. Worker queries for `PENDING` reports with no lock or stale locks
2. Uses `FOR UPDATE SKIP LOCKED` to atomically claim one job
3. Updates report to `RUNNING` with `locked_at` and `locked_by` fields
4. Processes the report and creates artifact
5. Updates report to `COMPLETED`

This ensures:
- Only one worker can claim a specific job at a time
- Multiple workers can process different jobs concurrently
- No race conditions in multi-instance deployments

### Idempotency Strategy

#### Request-Level Idempotency

- Client provides optional `Idempotency-Key` header
- Key is stored in `reports.idempotency_key` with UNIQUE constraint
- Duplicate requests with same key return existing report (200 OK)
- Race conditions handled via database constraint violations

#### Execution-Level Idempotency

- `report_artifacts.report_id` has UNIQUE constraint
- Only one artifact can exist per report
- If artifact insert fails due to unique constraint:
  - Another worker already created the artifact
  - Current worker converges state to `COMPLETED`
  - No duplicate artifacts created

### Stale Lock Recovery

Workers implement lease-based locking:

- Each claimed job has `locked_at` timestamp
- If `locked_at` is older than `WORKER_STALE_LOCK_TIMEOUT_MS` (default: 5 minutes), lock is considered stale
- Stale locks are periodically recovered:
  - Status reset to `PENDING`
  - Lock fields cleared
  - Job becomes available for other workers

This handles:
- Worker crashes during execution
- Network partitions
- Long-running jobs that exceed timeout

## Database Schema

### `reports`
- `id`: UUID primary key
- `tenant_id`: UUID, tenant identifier
- `type`: Report type (USAGE_SUMMARY, BILLING_EXPORT, AUDIT_SNAPSHOT)
- `params`: JSONB, report parameters
- `status`: PENDING | RUNNING | COMPLETED | FAILED
- `attempts`: Number of execution attempts
- `idempotency_key`: Optional unique key for request idempotency
- `locked_at`: Timestamp when job was claimed
- `locked_by`: Worker instance identifier
- `created_at`, `updated_at`: Timestamps

### `report_artifacts`
- `id`: UUID primary key
- `report_id`: UUID, unique foreign key to reports (enforces exactly-once)
- `content_type`: MIME type of artifact
- `content`: BYTEA, artifact binary content
- `size_bytes`: Size of artifact
- `checksum`: SHA-256 checksum
- `created_at`: Timestamp

### `report_executions`
- `id`: UUID primary key
- `report_id`: UUID, foreign key to reports
- `attempt`: Attempt number
- `started_at`, `finished_at`: Execution timestamps
- `error`: Error message if execution failed

## API Endpoints

### POST /reports

Create a new report job.

**Headers:**
- `Idempotency-Key` (optional): Idempotency key for duplicate request prevention

**Request Body:**
```json
{
  "tenantId": "550e8400-e29b-41d4-a716-446655440000",
  "type": "USAGE_SUMMARY",
  "params": {
    "from": "2024-01-01",
    "to": "2024-01-31",
    "format": "CSV"
  }
}
```

**Response:**
- `201 Created`: New report created
- `200 OK`: Report already exists (idempotent response)

### GET /reports/:id

Get report status and metadata.

**Response:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "tenantId": "...",
  "type": "USAGE_SUMMARY",
  "params": {...},
  "status": "COMPLETED",
  "attempts": 1,
  "createdAt": "2024-01-01T00:00:00Z",
  "updatedAt": "2024-01-01T00:00:00Z",
  "artifact": {
    "id": "...",
    "contentType": "text/csv",
    "sizeBytes": 1024,
    "checksum": "...",
    "createdAt": "..."
  }
}
```

### GET /reports/:id/download

Download report artifact.

**Response:**
- `200 OK`: Artifact streamed with appropriate Content-Type
- `409 Conflict`: Report not completed
- `404 Not Found`: Report or artifact not found

### GET /tenants/:tenantId/reports

List reports for a tenant.

**Query Parameters:**
- `status` (optional): Filter by status
- `type` (optional): Filter by type
- `limit` (optional, default: 20): Page size
- `cursor` (optional): Pagination cursor

### GET /health

Health check endpoint.

## Failure Modes & Recovery

### Worker Crash During Execution

**Scenario**: Worker crashes after claiming job but before completion.

**Recovery**:
1. Stale lock timeout expires (default: 5 minutes)
2. Another worker detects stale lock
3. Resets job to `PENDING`
4. Job is retried by another worker

### Worker Crash After Artifact Creation

**Scenario**: Worker crashes after creating artifact but before updating status to `COMPLETED`.

**Recovery**:
1. Another worker claims the job
2. Attempts to create artifact
3. Unique constraint violation detected
4. Worker converges state to `COMPLETED`
5. No duplicate artifact created

### Database Connection Loss

**Scenario**: Worker loses database connection during execution.

**Recovery**:
1. Transaction rolls back
2. Lock is released
3. Job remains `PENDING`
4. Another worker can claim it
5. Retry logic handles transient failures

### Concurrent Requests with Same Idempotency Key

**Scenario**: Multiple requests arrive simultaneously with same `Idempotency-Key`.

**Recovery**:
1. First request creates report
2. Subsequent requests hit UNIQUE constraint
3. Service queries for existing report
4. All requests return same report ID
5. Only one report row exists

## Configuration

Environment variables (see `.env.example`):

- `DATABASE_URL`: PostgreSQL connection string
- `PORT`: API server port (default: 3000)
- `WORKER_POLL_INTERVAL_MS`: Worker poll interval (default: 5000ms)
- `WORKER_STALE_LOCK_TIMEOUT_MS`: Stale lock timeout (default: 300000ms = 5min)
- `WORKER_MAX_ATTEMPTS`: Maximum retry attempts (default: 3)
- `WORKER_INSTANCE_ID`: Worker instance identifier
- `LOG_LEVEL`: Logging level (default: info)
- `NODE_ENV`: Environment (development | production)

## Getting Started

### Prerequisites

- Node.js 20+
- Docker and Docker Compose
- npm or yarn

### Local Development

1. **Clone and install dependencies:**
   ```bash
   npm install
   ```

2. **Start PostgreSQL:**
   ```bash
   docker-compose up -d
   ```

3. **Run Prisma migrations:**
   ```bash
   npm run prisma:migrate
   ```

4. **Generate Prisma client:**
   ```bash
   npm run prisma:generate
   ```

5. **Start API server:**
   ```bash
   npm run start:dev
   ```

6. **Start worker (in separate terminal):**
   ```bash
   npm run build
   npm run start:worker
   ```

7. **Access Swagger documentation:**
   ```
   http://localhost:3000/api
   ```

### Running Tests

Integration tests use Testcontainers to spin up isolated PostgreSQL instances:

```bash
# Run all tests
npm test

# Run e2e tests
npm run test:e2e

# Run with coverage
npm run test:cov
```

### Production Deployment

1. **Build the application:**
   ```bash
   npm run build
   ```

2. **Run migrations:**
   ```bash
   npm run prisma:migrate:deploy
   ```

3. **Start API server:**
   ```bash
   npm run start:prod
   ```

4. **Start worker(s):**
   ```bash
   npm run start:worker
   ```

For Kubernetes deployments:
- Deploy API server as a Deployment with multiple replicas
- Deploy worker as a separate Deployment with multiple replicas
- Use the same database connection string for all instances
- Set unique `WORKER_INSTANCE_ID` per worker pod (e.g., using pod name)

## Observability

### Logging

Structured logging with Pino:
- Correlation IDs via `x-correlation-id` header
- Request/response logging
- Worker execution logs
- Error tracking

### Health Checks

- `GET /health`: Database connectivity check
- Returns `healthy` or `unhealthy` status

### Metrics

Basic metrics available via logs:
- Report creation rate
- Worker processing rate
- Error rates
- Execution times

For production, consider adding Prometheus metrics endpoint.

## Testing Strategy

The test suite includes:

1. **Request Idempotency Test**: Verifies duplicate requests with same `Idempotency-Key` return same report
2. **Multi-Worker Safety Test**: Ensures exactly one artifact per report with concurrent workers
3. **Crash Simulation Test**: Verifies recovery after crash between artifact creation and status update

All tests use Testcontainers for isolated database instances.

## Project Structure

```
src/
├── app.module.ts              # Root module
├── main.ts                    # API server entrypoint
├── worker.ts                  # Worker entrypoint
├── app.controller.ts         # Health check controller
├── app.service.ts            # Health check service
├── common/                    # Shared utilities
│   ├── filters/              # Exception filters
│   └── interceptors/         # Request interceptors
├── prisma/                    # Prisma setup
│   ├── prisma.module.ts
│   └── prisma.service.ts
└── reports/                   # Reports module
    ├── reports.module.ts
    ├── reports.controller.ts  # API endpoints
    ├── reports.service.ts     # Business logic
    ├── report-worker.service.ts  # Background worker
    └── dto/                   # Data transfer objects
```

## License

MIT

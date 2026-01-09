-- CreateTable
CREATE TABLE "reports" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "idempotency_key" TEXT,
    "locked_at" TIMESTAMP(3),
    "locked_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_artifacts" (
    "id" TEXT NOT NULL,
    "report_id" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_executions" (
    "id" TEXT NOT NULL,
    "report_id" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "report_executions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reports_idempotency_key_key" ON "reports"("idempotency_key");

-- CreateIndex
CREATE INDEX "reports_tenant_id_status_idx" ON "reports"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "reports_status_locked_at_idx" ON "reports"("status", "locked_at");

-- CreateIndex
CREATE UNIQUE INDEX "report_artifacts_report_id_key" ON "report_artifacts"("report_id");

-- CreateIndex
CREATE INDEX "report_executions_report_id_idx" ON "report_executions"("report_id");

-- AddForeignKey
ALTER TABLE "report_artifacts" ADD CONSTRAINT "report_artifacts_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_executions" ADD CONSTRAINT "report_executions_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

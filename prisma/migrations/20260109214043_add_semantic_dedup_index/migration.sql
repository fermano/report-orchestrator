-- CreateIndex
CREATE INDEX "reports_tenant_id_type_status_idx" ON "reports"("tenant_id", "type", "status");

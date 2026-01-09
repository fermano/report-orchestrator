# Testing Scripts

## Test Idempotency

Test idempotency by sending multiple concurrent requests with the same idempotency key.

### Option 1: Node.js Script (Recommended)

```bash
# Make sure the API server is running first
npm run start:dev

# In another terminal, run:
node scripts/test-idempotency.js

# Or with custom settings:
API_URL=http://localhost:3000 NUM_REQUESTS=10 node scripts/test-idempotency.js
```

### Option 2: Bash Script

```bash
# Make sure the API server is running first
npm run start:dev

# In another terminal, run:
./scripts/test-idempotency.sh

# Or with custom API URL:
API_URL=http://localhost:3000 ./scripts/test-idempotency.sh
```

### Option 3: Using curl manually

```bash
# Set variables
IDEMPOTENCY_KEY="test-$(date +%s)"
TENANT_ID="your-tenant-id"

# Send multiple requests in parallel
for i in {1..5}; do
  curl -X POST http://localhost:3000/reports \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
    -d "{
      \"tenantId\": \"$TENANT_ID\",
      \"type\": \"USAGE_SUMMARY\",
      \"params\": {
        \"from\": \"2024-01-01\",
        \"to\": \"2024-01-31\",
        \"format\": \"CSV\"
      }
    }" &
done
wait
```

### Option 4: Using Postman/Insomnia

1. Create a new POST request to `http://localhost:3000/reports`
2. Add header: `Idempotency-Key: test-key-123`
3. Set body (JSON):
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
4. Use Postman's "Runner" or "Collection Runner" to send the same request multiple times
5. Or use the "Send" button multiple times quickly

### Option 5: Using Apache Bench (ab)

```bash
# Create a request file
cat > /tmp/report.json <<EOF
{
  "tenantId": "550e8400-e29b-41d4-a716-446655440000",
  "type": "USAGE_SUMMARY",
  "params": {
    "from": "2024-01-01",
    "to": "2024-01-31",
    "format": "CSV"
  }
}
EOF

# Send 10 concurrent requests
ab -n 10 -c 10 -p /tmp/report.json -T application/json \
   -H "Idempotency-Key: test-key-123" \
   http://localhost:3000/reports
```

### Verifying Results

After running any of the above, verify in the database:

```bash
# Check how many reports were created with the same idempotency key
psql $DATABASE_URL -c "SELECT id, idempotency_key, status, created_at FROM reports WHERE idempotency_key = 'YOUR_KEY';"

# Should return only ONE row, regardless of how many requests were sent
```

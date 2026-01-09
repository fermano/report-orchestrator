#!/bin/bash

# Simple script to test idempotency with concurrent requests
# Usage: ./scripts/test-idempotency.sh

API_URL="${API_URL:-http://localhost:3000}"
IDEMPOTENCY_KEY="test-key-$(date +%s)"

echo "Testing idempotency with key: $IDEMPOTENCY_KEY"
echo "Sending 5 concurrent requests..."
echo ""

# Create a report DTO
TENANT_ID=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || python3 -c "import uuid; print(uuid.uuid4())")
REPORT_DATA=$(cat <<EOF
{
  "tenantId": "$TENANT_ID",
  "type": "USAGE_SUMMARY",
  "params": {
    "from": "2024-01-01",
    "to": "2024-01-31",
    "format": "CSV"
  }
}
EOF
)

# Send 5 concurrent requests
for i in {1..5}; do
  (
    echo "Request $i:"
    RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}\n" \
      -X POST "$API_URL/reports" \
      -H "Content-Type: application/json" \
      -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
      -d "$REPORT_DATA")
    
    HTTP_CODE=$(echo "$RESPONSE" | grep "HTTP_CODE" | cut -d: -f2)
    BODY=$(echo "$RESPONSE" | sed '/HTTP_CODE/d')
    REPORT_ID=$(echo "$BODY" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
    
    echo "  Status: $HTTP_CODE"
    echo "  Report ID: $REPORT_ID"
    echo ""
  ) &
done

# Wait for all requests to complete
wait

echo "All requests completed!"
echo ""
echo "Check the database to verify only one report was created:"
echo "  psql \$DATABASE_URL -c \"SELECT id, idempotency_key, created_at FROM reports WHERE idempotency_key = '$IDEMPOTENCY_KEY';\""

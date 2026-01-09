#!/usr/bin/env node

/**
 * Test idempotency by sending multiple concurrent requests
 * Usage: node scripts/test-idempotency.js
 */

const http = require('http');

const API_URL = process.env.API_URL || 'http://localhost:3000';
const NUM_REQUESTS = parseInt(process.env.NUM_REQUESTS || '5', 10);
const idempotencyKey = `test-key-${Date.now()}`;

const tenantId = require('crypto').randomUUID();

const reportData = JSON.stringify({
  tenantId,
  type: 'USAGE_SUMMARY',
  params: {
    from: '2024-01-01',
    to: '2024-01-31',
    format: 'CSV',
  },
});

console.log(`Testing idempotency with key: ${idempotencyKey}`);
console.log(`Sending ${NUM_REQUESTS} concurrent requests to ${API_URL}/reports\n`);

const makeRequest = (index) => {
  return new Promise((resolve, reject) => {
    const url = new URL(`${API_URL}/reports`);
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
        'Content-Length': Buffer.byteLength(reportData),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const body = JSON.parse(data);
          resolve({
            index,
            statusCode: res.statusCode,
            reportId: body.id,
            status: body.status,
          });
        } catch (e) {
          resolve({
            index,
            statusCode: res.statusCode,
            error: data,
          });
        }
      });
    });

    req.on('error', (error) => {
      reject({ index, error: error.message });
    });

    req.write(reportData);
    req.end();
  });
};

// Send all requests concurrently
const requests = Array.from({ length: NUM_REQUESTS }, (_, i) => makeRequest(i + 1));

Promise.all(requests)
  .then((results) => {
    console.log('Results:\n');
    results.forEach((result) => {
      if (result.error) {
        console.log(`Request ${result.index}: ERROR - ${result.error}`);
      } else {
        console.log(
          `Request ${result.index}: ${result.statusCode} - Report ID: ${result.reportId} (Status: ${result.status})`,
        );
      }
    });

    // Check if all requests returned the same report ID
    const reportIds = results
      .filter((r) => r.reportId)
      .map((r) => r.reportId);
    const uniqueIds = new Set(reportIds);

    console.log('\n--- Analysis ---');
    if (uniqueIds.size === 1) {
      console.log('✅ SUCCESS: All requests returned the same report ID');
      console.log(`   Report ID: ${Array.from(uniqueIds)[0]}`);
    } else {
      console.log('❌ FAILURE: Different report IDs returned');
      console.log(`   Unique IDs: ${Array.from(uniqueIds).join(', ')}`);
    }

    const statusCodes = results.map((r) => r.statusCode);
    const createdCount = statusCodes.filter((c) => c === 201).length;
    const existingCount = statusCodes.filter((c) => c === 200).length;

    console.log(`\nStatus codes: ${createdCount} created (201), ${existingCount} existing (200)`);
    console.log(`\nTo verify in database:`);
    console.log(
      `  psql $DATABASE_URL -c "SELECT id, idempotency_key, status, created_at FROM reports WHERE idempotency_key = '${idempotencyKey}';"`,
    );
  })
  .catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  });

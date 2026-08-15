#!/usr/bin/env node
/**
 * Replay the same webhook N times (Node load helper — no k6 required).
 *
 *   DRIVER_ID=uuid node scripts/webhook-idempotency-load.mjs
 */
import crypto from 'crypto';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const SECRET = process.env.PAYMENT_WEBHOOK_SECRET || 'change-me-webhook-secret';
const DRIVER_ID = process.env.DRIVER_ID;
const N = Number(process.env.REPLAYS || 20);
const REF = process.env.PROVIDER_REF || `idem-load-${Date.now()}`;

if (!DRIVER_ID) {
  console.error('DRIVER_ID required');
  process.exit(1);
}

const payload = {
  provider: 'chapa',
  providerReference: REF,
  driverId: DRIVER_ID,
  amount: '1000',
  rawPayload: { source: 'webhook-idempotency-load' },
};
const body = JSON.stringify(payload);
const signature = crypto
  .createHmac('sha256', SECRET)
  .update(body)
  .digest('hex');

async function once() {
  const res = await fetch(`${BASE}/subscription/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-webhook-signature': signature,
    },
    body,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const results = await Promise.all(Array.from({ length: N }, () => once()));
const activated = results.filter((r) => r.json?.activated === true).length;
const duplicates = results.filter(
  (r) => r.json?.alreadyProcessed === true,
).length;
const errors = results.filter((r) => r.status >= 400).length;

console.log(
  JSON.stringify(
    { ref: REF, n: N, activated, duplicates, errors, sample: results[0] },
    null,
    2,
  ),
);

if (activated > 1 || errors > 0) {
  process.exit(1);
}

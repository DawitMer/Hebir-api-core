#!/usr/bin/env node
/**
 * Print HMAC signature for subscription webhook body (same algo as controller).
 *
 *   node scripts/sign-webhook.mjs --driver-id UUID --ref my-ref [--amount 1000]
 */
import crypto from 'crypto';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const driverId = arg('--driver-id', process.env.DRIVER_ID);
const ref = arg('--ref', process.env.PROVIDER_REF || `ref-${Date.now()}`);
const amount = arg('--amount', '1000');
const secret =
  arg('--secret', process.env.PAYMENT_WEBHOOK_SECRET) ||
  'change-me-webhook-secret';

if (!driverId) {
  console.error('Missing --driver-id / DRIVER_ID');
  process.exit(1);
}

const payload = {
  provider: 'chapa',
  providerReference: ref,
  driverId,
  amount,
  rawPayload: { source: 'sign-webhook' },
};

const body = JSON.stringify(payload);
const signature = crypto
  .createHmac('sha256', secret)
  .update(body)
  .digest('hex');

console.log(
  JSON.stringify(
    {
      payload,
      signature,
      exportHint: `export PROVIDER_REF=${ref} WEBHOOK_SIGNATURE=${signature} DRIVER_ID=${driverId}`,
    },
    null,
    2,
  ),
);

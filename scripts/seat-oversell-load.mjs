#!/usr/bin/env node
/**
 * Concurrent driver accepts against multiple holds on a 1-seat trip.
 * Expect exactly one success and the rest 409.
 *
 * Prep: create trip with 1 seat, create N held bookings (different riders),
 * then:
 *   DRIVER_TOKEN=... BOOKING_IDS=id1,id2,id3 node scripts/seat-oversell-load.mjs
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const TOKEN = process.env.DRIVER_TOKEN;
const IDS = (process.env.BOOKING_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!TOKEN || IDS.length < 2) {
  console.error('DRIVER_TOKEN and BOOKING_IDS (>=2) required');
  process.exit(1);
}

async function accept(bookingId) {
  const res = await fetch(`${BASE}/bookings/${bookingId}/accept`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { bookingId, status: res.status, json };
}

const results = await Promise.all(IDS.map((id) => accept(id)));
const ok = results.filter((r) => r.status >= 200 && r.status < 300);
const conflict = results.filter((r) => r.status === 409);

console.log(
  JSON.stringify(
    {
      total: results.length,
      ok: ok.length,
      conflict: conflict.length,
      results,
    },
    null,
    2,
  ),
);

if (ok.length !== 1) {
  console.error('EXPECTED exactly one successful accept (zero oversell)');
  process.exit(1);
}

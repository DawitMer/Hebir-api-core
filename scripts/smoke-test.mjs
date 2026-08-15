import crypto from 'crypto';

const BASE = process.env.API_BASE_URL ?? 'http://localhost:3000';
const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET ?? 'change-me-webhook-secret';
const DEMO_DRIVER_PHONE = process.env.SMOKE_DRIVER_PHONE ?? '+251911200001';

async function otpLogin(phoneNumber, roles) {
  const reqRes = await fetch(`${BASE}/auth/otp/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber }),
  });
  const req = await reqRes.json();
  if (!reqRes.ok || !req.debugCode) {
    throw new Error(`OTP request failed: ${JSON.stringify(req)}`);
  }
  const loginRes = await fetch(`${BASE}/auth/otp/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber, code: req.debugCode, roles }),
  });
  const login = await loginRes.json();
  if (!loginRes.ok || !login.accessToken) {
    throw new Error(`OTP login failed: ${JSON.stringify(login)}`);
  }
  return login;
}

async function main() {
  const login = await otpLogin(DEMO_DRIVER_PHONE, ['driver']);
  if (!login.accessToken || !login.user?.id) {
    throw new Error(
      `Driver login failed: ${JSON.stringify(login)} — run: npm run seed:demo`,
    );
  }
  const driverToken = login.accessToken;
  const driverId = login.user.id;

  const payload = {
    provider: 'chapa',
    providerReference: 'ref-' + Date.now(),
    driverId,
    amount: '1000',
    rawPayload: {},
  };
  const signature = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(JSON.stringify(payload))
    .digest('hex');

  const webhookRes = await fetch(`${BASE}/subscription/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-signature': signature },
    body: JSON.stringify(payload),
  });
  console.log('webhook:', webhookRes.status, await webhookRes.json());

  const statusRes = await fetch(`${BASE}/subscription/status`, {
    headers: { Authorization: `Bearer ${driverToken}` },
  });
  console.log('subscription status:', await statusRes.json());

  const tripRes = await fetch(`${BASE}/trips`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${driverToken}` },
    body: JSON.stringify({
      routePath: [
        { lat: 8.9870, lng: 38.7903 },
        { lat: 8.9900, lng: 38.7880 },
        { lat: 9.0122, lng: 38.7614 },
      ],
      startPoint: { lat: 8.9870, lng: 38.7903 },
      destination: { lat: 9.0122, lng: 38.7614 },
      departureTime: new Date(Date.now() + 10 * 60000).toISOString(),
      totalSeats: 3,
      pricePerSeat: 50,
    }),
  });
  const trip = await tripRes.json();
  console.log('trip:', tripRes.status, trip);

  const riderPhone =
    '+25191' + String(Math.floor(1000000 + Math.random() * 8999999));
  const rider = await otpLogin(riderPhone, ['rider']);
  const riderToken = rider.accessToken;

  const requestRes = await fetch(`${BASE}/rider-requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${riderToken}` },
    body: JSON.stringify({
      pickup: { lat: 8.988, lng: 38.789 },
      dropoff: { lat: 9.011, lng: 38.762 },
      earliestDeparture: new Date(Date.now()).toISOString(),
      latestDeparture: new Date(Date.now() + 45 * 60000).toISOString(),
      seatsNeeded: 1,
      priceCeiling: 100,
    }),
  });
  const riderRequest = await requestRes.json();
  console.log('riderRequest:', requestRes.status, riderRequest);

  const matchesRes = await fetch(`${BASE}/rider-requests/${riderRequest.id}/matches`, {
    headers: { Authorization: `Bearer ${riderToken}` },
  });
  const matches = await matchesRes.json();
  console.log('matches:', matchesRes.status, matches);

  const bookingRes = await fetch(`${BASE}/bookings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${riderToken}` },
    body: JSON.stringify({
      tripId: trip.id,
      riderRequestId: riderRequest.id,
      seats: 1,
    }),
  });
  const booking = await bookingRes.json();
  console.log('booking (held):', bookingRes.status, booking);

  const acceptRes = await fetch(`${BASE}/bookings/${booking.id}/accept`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${driverToken}` },
  });
  console.log('accept:', acceptRes.status, await acceptRes.json());

  const tripAfterRes = await fetch(`${BASE}/rider-requests/${riderRequest.id}/matches`, {
    headers: { Authorization: `Bearer ${riderToken}` },
  });
  console.log(
    'trip remainingSeats after accept:',
    (await tripAfterRes.json())[0]?.trip?.remainingSeats ?? 'n/a (trip may be filtered/withdrawn)',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

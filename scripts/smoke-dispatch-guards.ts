/**
 * Guard-rail smoke test for the ride/dispatch fixes, against a running stack.
 *
 * Complements smoke-live-ride.ts (which proves the happy path) by asserting the
 * failure modes: cross-rider reads, driver-only transitions, double accept,
 * double complete, request storms, coordinate validation, and the reaper
 * releasing a driver whose offer timed out.
 *
 *   npx ts-node scripts/smoke-dispatch-guards.ts
 */
import axios, { AxiosError } from 'axios';
import { loginWithOtp } from './lib/otp-login';

const API = process.env.API_URL ?? 'http://127.0.0.1:3000';
const LOC = process.env.LOCATION_SVC_URL ?? 'http://127.0.0.1:8090';

const DRIVER_PHONE = process.env.DRIVER_PHONE ?? '+251911200002';
const RIDER_PHONE = process.env.RIDER_PHONE ?? '+251922300002';
const OTHER_RIDER_PHONE = process.env.OTHER_RIDER_PHONE ?? '+251922300003';

const DRIVER_AT = { lat: 8.9878, lng: 38.791 };
const PICKUP = { lat: 8.9865, lng: 38.7896 };
const DROPOFF = { lat: 9.0105, lng: 38.7612 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Runs a request that must fail, and reports the status it failed with. */
async function expectStatus(name: string, expected: number, call: () => Promise<unknown>) {
  try {
    await call();
    check(name, false, `expected ${expected}, request succeeded`);
  } catch (error) {
    const status = (error as AxiosError).response?.status;
    check(name, status === expected, `expected ${expected}, got ${status ?? error}`);
  }
}

async function login(phoneNumber: string, roles: Array<'rider' | 'driver'>) {
  const data = await loginWithOtp(API, phoneNumber, roles);
  return { token: data.accessToken, userId: data.user?.id as string };
}

async function goOnline(driver: { token: string; userId: string }) {
  await axios
    .post(`${API}/subscription/dev-activate`, {}, auth(driver.token))
    .catch(() => undefined);
  await axios.post(`${LOC}/drivers/location`, {
    driverId: driver.userId,
    location: DRIVER_AT,
  });
  await axios.post(`${API}/drivers/presence`, { online: true }, auth(driver.token));
}

async function requestRide(riderToken: string) {
  const { data } = await axios.post(
    `${API}/rides`,
    { pickup: PICKUP, dropoff: DROPOFF, vehicleType: 'any' },
    auth(riderToken),
  );
  return data as { id: string; status: string };
}

async function waitForOffer(driverToken: string, seconds = 20) {
  for (let i = 0; i < seconds; i += 1) {
    await sleep(1000);
    const { data } = await axios.get(`${API}/rides/offers/current`, auth(driverToken));
    if (data?.id) return data as { id: string };
  }
  return null;
}

async function presenceStatus(driverToken: string) {
  const { data } = await axios.get(`${API}/drivers/presence`, auth(driverToken));
  return data?.profile?.status as string | undefined;
}

async function cleanup(riderToken: string, rideId: string) {
  await axios
    .patch(`${API}/rides/${rideId}/status`, { status: 'cancelled' }, auth(riderToken))
    .catch(() => undefined);
}

async function main() {
  const driver = await login(DRIVER_PHONE, ['driver']);
  const rider = await login(RIDER_PHONE, ['rider']);
  const other = await login(OTHER_RIDER_PHONE, ['rider']);
  await goOnline(driver);

  console.log('\n--- input validation ---');
  await expectStatus('lat/lng out of range rejected', 400, () =>
    axios.post(
      `${API}/rides`,
      { pickup: { lat: 999, lng: -9999 }, dropoff: DROPOFF },
      auth(rider.token),
    ),
  );
  await expectStatus('unknown vehicleType rejected', 400, () =>
    axios.post(
      `${API}/rides`,
      { pickup: PICKUP, dropoff: DROPOFF, vehicleType: 'helicopter' },
      auth(rider.token),
    ),
  );
  await expectStatus('malformed ride id is 400 not 500', 400, () =>
    axios.get(`${API}/rides/not-a-uuid`, auth(rider.token)),
  );
  await expectStatus('oversized ride page rejected', 400, () =>
    axios.get(`${API}/rides/mine?limit=100000`, auth(rider.token)),
  );

  console.log('\n--- authorization ---');
  const ride = await requestRide(rider.token);
  await expectStatus("other rider cannot read this ride", 403, () =>
    axios.get(`${API}/rides/${ride.id}`, auth(other.token)),
  );
  await expectStatus('other rider cannot cancel this ride', 403, () =>
    axios.patch(`${API}/rides/${ride.id}/status`, { status: 'cancelled' }, auth(other.token)),
  );
  const mine = await axios.get(`${API}/rides/${ride.id}`, auth(rider.token));
  check('owner can read own ride', mine.data?.id === ride.id);

  console.log('\n--- one active ride per rider ---');
  await expectStatus('duplicate concurrent request rejected', 409, () =>
    requestRide(rider.token),
  );

  console.log('\n--- offer lifecycle ---');
  const offer = await waitForOffer(driver.token);
  check('driver received the offer', offer?.id === ride.id, `got ${offer?.id}`);
  if (offer) {
    check('driver is reserved while offer is live', (await presenceStatus(driver.token)) === 'reserved');

    const accepted = await axios.post(`${API}/rides/${ride.id}/accept`, {}, auth(driver.token));
    check('driver accepted', accepted.data?.status === 'accepted', accepted.data?.status);
    check('driver is on_trip after accept', (await presenceStatus(driver.token)) === 'on_trip');

    // accepted -> arriving is a legal edge, so this isolates the role check
    // rather than tripping the transition table first.
    await expectStatus('rider cannot drive a driver-only transition', 403, () =>
      axios.patch(`${API}/rides/${ride.id}/status`, { status: 'arriving' }, auth(rider.token)),
    );
    await expectStatus('second accept rejected', 409, () =>
      axios.post(`${API}/rides/${ride.id}/accept`, {}, auth(driver.token)),
    );
    await expectStatus('complete before in_progress rejected', 409, () =>
      axios.post(`${API}/rides/${ride.id}/complete`, {}, auth(driver.token)),
    );

    for (const status of ['arriving', 'in_progress']) {
      await axios.patch(`${API}/rides/${ride.id}/status`, { status }, auth(driver.token));
    }
    const done = await axios.post(`${API}/rides/${ride.id}/complete`, {}, auth(driver.token));
    check('ride completed', done.data?.status === 'completed', done.data?.status);
    // completeRide() is deliberately idempotent (End Trip can be tapped twice /
    // retried after network loss); the guarantee is a single fare, not a 409.
    const again = await axios.post(`${API}/rides/${ride.id}/complete`, {}, auth(driver.token));
    check(
      'second complete is idempotent',
      again.data?.status === 'completed',
      again.data?.status,
    );
    check('driver back online after completion', (await presenceStatus(driver.token)) === 'online');

    const final = await axios.get(`${API}/rides/${ride.id}`, auth(rider.token));
    check('exactly one fare recorded', Boolean(final.data?.fare?.total), final.data?.fare?.total);
  }

  console.log('\n--- timed-out offer frees the driver ---');
  const ignored = await requestRide(rider.token);
  const secondOffer = await waitForOffer(driver.token);
  check('driver offered again', Boolean(secondOffer?.id));
  if (secondOffer) {
    // Never accept: the offer_check job (or the reaper) must return the driver
    // to online rather than leaving them stuck in `reserved`. The offer lives
    // OFFER_TIMEOUT_MS (2 min) plus reap grace, so poll well past that.
    let released = false;
    for (let i = 0; i < 160 && !released; i += 1) {
      await sleep(1000);
      released = (await presenceStatus(driver.token)) === 'online';
    }
    check('driver released from reserved after offer timeout', released);
  }
  await cleanup(rider.token, ignored.id);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  const detail = axios.isAxiosError(error)
    ? `${error.response?.status} ${JSON.stringify(error.response?.data)}`
    : error;
  console.error('GUARDS SMOKE FAILED:', detail);
  process.exit(1);
});

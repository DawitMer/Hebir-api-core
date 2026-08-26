/**
 * End-to-end smoke test for the on-demand ride flow against a running stack.
 *
 * Drives a real rider + driver through request -> offer -> accept -> arriving
 * -> in_progress -> complete, and prints the addresses api-core persisted so
 * reverse geocoding can be verified without the mobile apps.
 *
 *   npx ts-node scripts/smoke-live-ride.ts
 */
import axios from 'axios';
import { loginWithOtp } from './lib/otp-login';

const API = process.env.API_URL ?? 'http://127.0.0.1:3000';
const LOC = process.env.LOCATION_SVC_URL ?? 'http://127.0.0.1:8090';

const DRIVER_PHONE = process.env.DRIVER_PHONE ?? '+251911200001';
const RIDER_PHONE = process.env.RIDER_PHONE ?? '+251922300001';

/** Bole: driver sits ~150 m from the rider's pickup pin. */
const DRIVER_AT = { lat: 8.9878, lng: 38.791 };
const PICKUP = { lat: 8.9865, lng: 38.7896 };
const DROPOFF = { lat: 9.0105, lng: 38.7612 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function login(phoneNumber: string, roles: Array<'rider' | 'driver'>) {
  const data = await loginWithOtp(API, phoneNumber, roles);
  return {
    token: data.accessToken,
    userId: data.user?.id as string,
    name: data.user?.fullName as string,
  };
}

const auth = (token: string) => ({
  headers: { Authorization: `Bearer ${token}` },
});

async function main() {
  const driver = await login(DRIVER_PHONE, ['driver']);
  const rider = await login(RIDER_PHONE, ['rider']);
  console.log(`driver ${driver.name} (${DRIVER_PHONE})`);
  console.log(`rider  ${rider.name} (${RIDER_PHONE})`);

  // Driver must be online, subscribed, and present in the geo index.
  await axios
    .post(`${API}/subscription/dev-activate`, {}, auth(driver.token))
    .catch(() => undefined);
  await axios.post(`${LOC}/drivers/offline`, { driverId: driver.userId }).catch(() => undefined);
  await axios.post(
    `${API}/drivers/location`,
    { lat: DRIVER_AT.lat, lng: DRIVER_AT.lng },
    auth(driver.token),
  );
  await axios.post(`${LOC}/drivers/location`, {
    driverId: driver.userId,
    location: DRIVER_AT,
  });
  await axios.post(`${API}/drivers/presence`, { online: true }, auth(driver.token));
  console.log('driver online + located');

  const activeRide = await axios.get(`${API}/rides/active`, auth(rider.token)).catch(() => undefined);
  if (activeRide?.data?.id) {
    if (activeRide.data.status === 'in_progress') {
      await axios.post(`${LOC}/drivers/location`, {
        driverId: driver.userId,
        location: activeRide.data.dropoff || DROPOFF,
      }).catch(() => undefined);
      await axios.post(`${API}/rides/${activeRide.data.id}/complete`, {}, auth(driver.token)).catch(() => undefined);
      await axios.post(`${LOC}/drivers/location`, {
        driverId: driver.userId,
        location: DRIVER_AT,
      }).catch(() => undefined);
    } else {
      await axios.patch(`${API}/rides/${activeRide.data.id}/status`, { status: 'cancelled' }, auth(rider.token)).catch(() => undefined);
    }
  }

  const { data: ride } = await axios.post(
    `${API}/rides`,
    {
      pickup: PICKUP,
      dropoff: DROPOFF,
      // Deliberately wrong labels: the server must override them from the pins.
      pickupAddress: 'WRONG CLIENT LABEL',
      dropoffAddress: 'WRONG CLIENT LABEL',
      vehicleType: 'any',
    },
    auth(rider.token),
  );
  console.log(`\nride ${ride.id} requested (${ride.status})`);
  console.log(`  pickup  -> ${ride.pickupAddress}`);
  console.log(`  dropoff -> ${ride.dropoffAddress}`);

  // Wait for dispatch to offer the ride to our driver.
  let offer: { id: string } | null = null;
  for (let i = 0; i < 20 && !offer; i += 1) {
    await sleep(1000);
    const { data } = await axios.get(`${API}/rides/offers/current`, auth(driver.token));
    if (data?.id) offer = data;
  }
  if (!offer) throw new Error('no offer reached the driver within 20s');
  console.log(`\ndriver received offer for ride ${offer.id}`);

  const { data: accepted } = await axios.post(
    `${API}/rides/${offer.id}/accept`,
    {},
    auth(driver.token),
  );
  console.log(`accepted -> status=${accepted.status}`);
  console.log(`  pickup  -> ${accepted.pickupAddress}`);
  console.log(`  dropoff -> ${accepted.dropoffAddress}`);

  for (const status of ['arriving', 'in_progress']) {
    const { data } = await axios.patch(
      `${API}/rides/${ride.id}/status`,
      { status },
      auth(driver.token),
    );
    console.log(`transition -> ${data.status}`);
  }

  await axios.post(`${LOC}/drivers/offline`, { driverId: driver.userId });
  await axios.post(`${LOC}/drivers/location`, {
    driverId: driver.userId,
    location: DROPOFF,
  });

  const { data: done } = await axios.post(
    `${API}/rides/${ride.id}/complete`,
    {},
    auth(driver.token),
  );
  console.log(`completed -> status=${done.status}`);

  const { data: final } = await axios.get(`${API}/rides/${ride.id}`, auth(rider.token));
  console.log('\nfinal ride as the rider sees it:');
  console.log(`  status  : ${final.status}`);
  console.log(`  pickup  : ${final.pickupAddress}`);
  console.log(`  dropoff : ${final.dropoffAddress}`);
  console.log(`  driver  : ${final.driver?.fullName} (${final.driver?.rating})`);
  console.log(`  vehicle : ${final.vehicle?.makeModel} ${final.vehicle?.plate}`);
  console.log(`  fare    : ${final.fare?.total} ETB`);

  // Leave no state behind: an online driver here would steal offers from
  // other smoke scripts (e.g. smoke-dispatch-guards.ts) run afterwards.
  await axios.post(`${API}/drivers/presence`, { online: false }, auth(driver.token));
  console.log('driver offline (cleanup)');
}

main().catch((error) => {
  const detail = axios.isAxiosError(error)
    ? `${error.response?.status} ${JSON.stringify(error.response?.data)}`
    : error;
  console.error('SMOKE FAILED:', detail);
  process.exit(1);
});

/**
 * Puts one seeded driver online next to one seeded rider in Bole, so the
 * Driver and Rider apps can be tried against a live match.
 *
 *   npx ts-node scripts/park-demo-pair.ts
 */
import axios from 'axios';
import { loginWithOtp } from './lib/otp-login';

const API = process.env.API_URL ?? 'http://127.0.0.1:3000';
const LOC = process.env.LOCATION_SVC_URL ?? 'http://127.0.0.1:8090';

const DRIVER_PHONE = process.env.DRIVER_PHONE ?? '+251911200001';
const RIDER_PHONE = process.env.RIDER_PHONE ?? '+251922300001';

/** Bole — the two sit roughly 150 m apart. */
const DRIVER_AT = { lat: 8.9878, lng: 38.791 };
const RIDER_AT = { lat: 8.9865, lng: 38.7896 };

async function login(phoneNumber: string, roles: Array<'rider' | 'driver'>) {
  const data = await loginWithOtp(API, phoneNumber, roles);
  return {
    token: data.accessToken,
    userId: data.user?.id as string,
    name: data.user?.fullName as string,
  };
}

const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

async function main() {
  const driver = await login(DRIVER_PHONE, ['driver']);
  const rider = await login(RIDER_PHONE, ['rider']);


  await axios
    .post(`${API}/subscription/dev-activate`, {}, auth(driver.token))
    .catch(() => undefined);

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

  const { data: presence } = await axios.get(`${API}/drivers/presence`, auth(driver.token));
  const { data: nearby } = await axios.get(`${LOC}/drivers/locations`, {
    params: { lat: RIDER_AT.lat, lng: RIDER_AT.lng, radiusKm: 1 },
  });
  const found = (nearby.drivers ?? []).some(
    (d: { driverId: string }) => d.driverId === driver.userId,
  );

  console.log('Ready to try:');
  console.log(`  Driver : ${driver.name}  ${DRIVER_PHONE}  (phone OTP)`);
  console.log(`           status=${presence.profile?.status} subscription=${presence.subscriptionActive}`);
  console.log(`           at ${DRIVER_AT.lat}, ${DRIVER_AT.lng} (Bole)`);
  console.log(`  Rider  : ${rider.name}  ${RIDER_PHONE}  (phone OTP)`);
  console.log(`           pickup ${RIDER_AT.lat}, ${RIDER_AT.lng} (~150 m away)`);
  console.log(`  Driver visible to rider within 1 km: ${found ? 'yes' : 'no'}`);
}

main().catch((error) => {
  const detail = axios.isAxiosError(error)
    ? `${error.response?.status} ${JSON.stringify(error.response?.data)}`
    : error;
  console.error('FAILED:', detail);
  process.exit(1);
});

/**
 * Seed script for local E2E: drivers around Addis, mixed subscriptions,
 * online presence, Redis geo pings via location-svc.
 *
 * Usage (api-core running + location-svc running):
 *   cd api-core && npx ts-node -r tsconfig-paths/register scripts/seed-and-dispatch.ts
 */
import axios from 'axios';
import { loginWithOtp } from './lib/otp-login';

const API = process.env.API_BASE_URL ?? 'http://127.0.0.1:3000';
const LOC = process.env.LOCATION_SVC_URL ?? 'http://127.0.0.1:8090';

const ADDIs = { lat: 8.9806, lng: 38.7578 };

function offset(lat: number, lng: number, dLat: number, dLng: number) {
  return { lat: lat + dLat, lng: lng + dLng };
}

async function auth(phone: string, role: 'driver' | 'rider', fullName: string) {
  const e164 = phone.startsWith('+') ? phone : `+251${phone}`;
  return loginWithOtp(API, e164, [role], fullName);
}

async function main() {
  console.log('Seeding drivers + rider around Addis…');

  const drivers = [
    { phone: '911111111', name: 'Abebe Online', dLat: 0.008, dLng: 0.004, activate: true },
    { phone: '911111112', name: 'Sara Online', dLat: -0.006, dLng: 0.009, activate: true },
    { phone: '911111113', name: 'Kaleb Lapsed', dLat: 0.01, dLng: -0.008, activate: false },
  ];

  const seededDrivers: { id: string; token: string; loc: { lat: number; lng: number }; activate: boolean }[] = [];

  for (const d of drivers) {
    const session = await auth(d.phone, 'driver', d.name);
    const headers = { Authorization: `Bearer ${session.accessToken}` };
    if (d.activate) {
      await axios.post(`${API}/subscription/dev-activate`, {}, { headers });
      await axios.post(
        `${API}/drivers/presence`,
        { online: true, connectedAccountId: `acct_demo_${d.phone}` },
        { headers },
      );
    }
    const loc = offset(ADDIs.lat, ADDIs.lng, d.dLat, d.dLng);
    await axios.post(`${LOC}/drivers/location`, {
      driverId: session.user.id,
      location: loc,
    });
    seededDrivers.push({
      id: session.user.id,
      token: session.accessToken,
      loc,
      activate: d.activate,
    });
    console.log(`  driver ${d.name} ${session.user.id} online=${d.activate}`);
  }

  const rider = await auth('922222221', 'rider', 'Hanna Rider');
  const riderHeaders = { Authorization: `Bearer ${rider.accessToken}` };
  console.log(`  rider ${rider.user.id}`);

  const pickup = offset(ADDIs.lat, ADDIs.lng, 0.001, 0.001);
  const dropoff = offset(ADDIs.lat, ADDIs.lng, 0.04, 0.03);

  console.log('Requesting on-demand ride…');
  const { data: ride } = await axios.post(
    `${API}/rides`,
    {
      pickup,
      dropoff,
      pickupAddress: 'Bole Road',
      dropoffAddress: 'Kazanchis',
      vehicleType: 'any',
    },
    { headers: riderHeaders },
  );
  console.log(`  ride ${ride.id} status=${ride.status}`);

  // Poll until offered/matched/unmatched
  let current = ride;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const { data } = await axios.get(`${API}/rides/${ride.id}`, {
      headers: riderHeaders,
    });
    current = data;
    console.log(`  t+${(i + 1) * 2}s status=${current.status} offer=${current.offerDriverId ?? '-'}`);

    if (current.status === 'offered' && current.offerDriverId) {
      const driver = seededDrivers.find((d) => d.id === current.offerDriverId);
      if (driver) {
        console.log('  accepting offer as driver…');
        await axios.post(
          `${API}/rides/${ride.id}/accept`,
          {},
          { headers: { Authorization: `Bearer ${driver.token}` } },
        );
      }
    }

    if (['accepted', 'matched', 'unmatched', 'cancelled'].includes(current.status)) {
      break;
    }
  }

  if (current.status === 'matched' || current.status === 'accepted') {
    const driver = seededDrivers.find((d) => d.id === current.driverId);
    if (driver) {
      await axios.patch(
        `${API}/rides/${ride.id}/status`,
        { status: 'arriving' },
        { headers: { Authorization: `Bearer ${driver.token}` } },
      );
      await axios.patch(
        `${API}/rides/${ride.id}/status`,
        { status: 'in_progress' },
        { headers: { Authorization: `Bearer ${driver.token}` } },
      );
      const { data: completed } = await axios.post(
        `${API}/rides/${ride.id}/complete`,
        {},
        { headers: { Authorization: `Bearer ${driver.token}` } },
      );
      console.log('  completed fare total=', completed?.fare?.total ?? completed?.status);

      const tipKey = `tip-${ride.id}-${Date.now()}`;
      const { data: tip } = await axios.post(
        `${API}/tips`,
        { rideId: ride.id, amount: 20, idempotencyKey: tipKey },
        { headers: riderHeaders },
      );
      console.log('  tip posted', tip.id, '→ driver', tip.driverId);

      await axios.post(
        `${API}/ratings`,
        { rideId: ride.id, stars: 5, comment: 'Great ride' },
        { headers: riderHeaders },
      );
      console.log('  rating posted');
    }
  }

  console.log('Done. Final status=', current.status);
}

main().catch((err) => {
  console.error(err.response?.data ?? err.message);
  process.exit(1);
});

/**
 * Seed Neon (Postgres via api-core) + Redis geo (location-svc) with real
 * Addis drivers/riders for live Flutter E2E. Writes user profile fields
 * (fullName, username, vehicle) into Neon via PATCH /users/me.
 *
 *   cd api-core && npm run seed:live
 */
import axios from 'axios';
import { loginWithOtp } from './lib/otp-login';

const API = process.env.API_BASE_URL ?? 'http://127.0.0.1:3000';
const LOC = process.env.LOCATION_SVC_URL ?? 'http://127.0.0.1:8090';
const PASSWORD = 'secret123';
const ADDIS = { lat: 8.9806, lng: 38.7578 };

function offset(lat: number, lng: number, dLat: number, dLng: number) {
  return { lat: lat + dLat, lng: lng + dLng };
}

async function auth(
  phone: string,
  role: 'driver' | 'rider' | 'admin' | 'gov_officer',
  fullName: string,
) {
  const e164 = phone.startsWith('+') ? phone : `+251${phone}`;
  if (role === 'admin' || role === 'gov_officer') {
    try {
      const { data } = await axios.post(`${API}/auth/login`, {
        phoneNumber: e164,
        password: PASSWORD,
      });
      return data as { accessToken: string; user: { id: string } };
    } catch {
      // Staff must be provisioned by seed:demo — do not create via public register.
      throw new Error(`Staff login failed for ${e164}; run npm run seed:demo`);
    }
  }
  return loginWithOtp(API, e164, [role], fullName);
}

async function main() {
  console.log(`Seeding Neon user profiles + Redis via ${API} / ${LOC}`);

  const drivers = [
    {
      phone: '911111111',
      name: 'Abebe Bekele',
      username: 'abebe_b',
      dLat: 0.008,
      dLng: 0.004,
      vehicle: {
        vehicleMake: 'Toyota',
        vehicleModel: 'Corolla',
        vehiclePlate: 'AA-B 12345',
        vehicleColor: 'White',
        vehicleCapacity: 4,
      },
    },
    {
      phone: '911111112',
      name: 'Sara Hailu',
      username: 'sara_h',
      dLat: -0.006,
      dLng: 0.009,
      vehicle: {
        vehicleMake: 'Hyundai',
        vehicleModel: 'Accent',
        vehiclePlate: 'AA-C 88221',
        vehicleColor: 'Silver',
        vehicleCapacity: 4,
      },
    },
    {
      phone: '911111114',
      name: 'Yonas Desta',
      username: 'yonas_d',
      dLat: 0.012,
      dLng: 0.002,
      vehicle: {
        vehicleMake: 'Suzuki',
        vehicleModel: 'Dzire',
        vehiclePlate: 'AA-D 44110',
        vehicleColor: 'Blue',
        vehicleCapacity: 4,
      },
    },
    {
      phone: '911111115',
      name: 'Marta Alemu',
      username: 'marta_a',
      dLat: -0.003,
      dLng: -0.007,
      vehicle: {
        vehicleMake: 'Toyota',
        vehicleModel: 'Yaris',
        vehiclePlate: 'AA-E 90901',
        vehicleColor: 'Black',
        vehicleCapacity: 4,
      },
    },
  ];

  for (const d of drivers) {
    const session = await auth(d.phone, 'driver', d.name);
    const headers = { Authorization: `Bearer ${session.accessToken}` };
    const { data: me } = await axios.patch(
      `${API}/users/me`,
      {
        fullName: d.name,
        username: d.username,
        ...d.vehicle,
      },
      { headers },
    );
    await axios.post(`${API}/subscription/dev-activate`, {}, { headers });
    await axios.post(
      `${API}/drivers/presence`,
      { online: true, connectedAccountId: `acct_${d.phone}` },
      { headers },
    );
    const loc = offset(ADDIS.lat, ADDIS.lng, d.dLat, d.dLng);
    try {
      await axios.post(`${LOC}/drivers/location`, {
        driverId: session.user.id,
        location: loc,
      });
    } catch (err: any) {
      console.warn(`  location-svc skip for ${d.phone}:`, err?.message ?? err);
    }
    try {
      await axios.post(
        `${API}/drivers/location`,
        { lat: loc.lat, lng: loc.lng },
        { headers },
      );
    } catch (err: any) {
      console.warn(`  api location skip for ${d.phone}:`, err?.response?.data ?? err?.message);
    }
    console.log(
      `  driver ${me.fullName} @${me.username} ${session.user.id} vehicle=${me.vehicle?.makeModel ?? 'n/a'}`,
    );
  }

  const lapsed = await auth('911111113', 'driver', 'Kaleb Lapsed');
  await axios.patch(
    `${API}/users/me`,
    { fullName: 'Kaleb Lapsed', username: 'kaleb_l' },
    { headers: { Authorization: `Bearer ${lapsed.accessToken}` } },
  );
  console.log(`  driver Kaleb Lapsed ${lapsed.user.id} offline`);

  const riders = [
    { phone: '922222221', name: 'Hanna Tadesse', username: 'hanna_t' },
    { phone: '922222222', name: 'Daniel Mekonnen', username: 'daniel_m' },
  ];
  for (const r of riders) {
    const session = await auth(r.phone, 'rider', r.name);
    const { data: me } = await axios.patch(
      `${API}/users/me`,
      { fullName: r.name, username: r.username },
      { headers: { Authorization: `Bearer ${session.accessToken}` } },
    );
    console.log(`  rider ${me.fullName} @${me.username} ${session.user.id}`);
  }

  try {
    const nearby = await axios.post(`${LOC}/drivers/nearby`, {
      lat: ADDIS.lat,
      lng: ADDIS.lng,
      radiusKm: 8,
      limit: 10,
    });
    console.log('  redis nearby drivers:', nearby.data?.driverIds?.length ?? nearby.data);
  } catch (err: any) {
    console.warn('  nearby skip:', err?.message ?? err);
  }

  // Prove read-back from Neon
  const probe = await auth('911111111', 'driver', 'Abebe Bekele');
  const { data: readBack } = await axios.get(`${API}/users/me`, {
    headers: { Authorization: `Bearer ${probe.accessToken}` },
  });
  console.log('  read-back Abebe:', readBack.fullName, readBack.username, readBack.vehicle?.plate);

  const admin = await auth('911000001', 'admin', 'Ops Admin');
  await axios.patch(
    `${API}/users/me`,
    { fullName: 'Ops Admin', username: 'ops_admin' },
    { headers: { Authorization: `Bearer ${admin.accessToken}` } },
  );
  const gov = await auth('911000002', 'gov_officer', 'Gov Officer');
  await axios.patch(
    `${API}/users/me`,
    { fullName: 'Gov Officer', username: 'gov_officer' },
    { headers: { Authorization: `Bearer ${gov.accessToken}` } },
  );
  const { data: boot } = await axios.post(
    `${API}/admin/bootstrap-demo`,
    {},
    { headers: { Authorization: `Bearer ${admin.accessToken}` } },
  );
  console.log('  portal users: ops +251911000001, gov +251911000002');
  console.log('  bootstrap-demo:', boot);

  console.log(
    'Seed complete. Drivers/riders: phone OTP. Ops+Gov portal password: secret123',
  );
}

main().catch((err) => {
  console.error(err.response?.data ?? err.message);
  process.exit(1);
});

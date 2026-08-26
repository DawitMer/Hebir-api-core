import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SA_PATH = path.resolve(__dirname, '../secrets/firebase-adminsdk.json');
const sa = JSON.parse(fs.readFileSync(SA_PATH, 'utf8'));
const PROJECT = sa.project_id;
const BASE = 'https://firebase.googleapis.com/v1beta1';

function mintJwt(scope) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email, scope,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  })).toString('base64url');
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(sa.private_key, 'base64url')}`;
}

async function getToken() {
  const jwt = mintJwt('https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/firebase');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Token: ${JSON.stringify(json)}`);
  return json.access_token;
}

async function apiPost(token, endpoint, body) {
  const res = await fetch(`${BASE}${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`POST ${endpoint}: ${JSON.stringify(json)}`);
  return json;
}

async function apiGet(token, endpoint) {
  const res = await fetch(`${BASE}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`GET ${endpoint}: ${JSON.stringify(json)}`);
  return json;
}

async function waitForOperation(token, opName) {
  // Poll until done
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`https://firebase.googleapis.com/v1beta1/${opName}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json();
    if (json.done) return json.response ?? json;
    await new Promise(r => setTimeout(r, 3000));
    process.stdout.write('.');
  }
  throw new Error('Operation timed out');
}

async function downloadConfig(token, resourceName) {
  const res = await fetch(`${BASE}/${resourceName}/config`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Config: ${JSON.stringify(json)}`);
  return Buffer.from(json.configFileContents, 'base64').toString('utf8');
}

const APPS = [
  { platform: 'android', packageName: 'com.hebir.hebir_rider', displayName: 'Hebir Rider' },
  { platform: 'android', packageName: 'com.hebir.hebir_driver', displayName: 'Hebir Driver' },
  { platform: 'ios', bundleId: 'com.hebir.hebirRider', displayName: 'Hebir Rider iOS' },
  { platform: 'ios', bundleId: 'com.hebir.hebirDriver', displayName: 'Hebir Driver iOS' },
];

(async () => {
  console.log('Getting access token...');
  const token = await getToken();

  for (const app of APPS) {
    const isAndroid = app.platform === 'android';
    const endpoint = isAndroid ? `/projects/${PROJECT}/androidApps` : `/projects/${PROJECT}/iosApps`;
    const body = isAndroid
      ? { packageName: app.packageName, displayName: app.displayName }
      : { bundleId: app.bundleId, displayName: app.displayName };
    const id = isAndroid ? app.packageName : app.bundleId;

    console.log(`\nRegistering ${app.platform} app: ${id}`);
    try {
      const op = await apiPost(token, endpoint, body);
      console.log(`  Operation: ${op.name}`);
      process.stdout.write('  Waiting');
      const result = await waitForOperation(token, op.name.replace('projects/', 'projects/'));
      console.log('\n  Registered!', JSON.stringify(result).slice(0, 120));

      // Download config
      const appName = result.name;
      const config = await downloadConfig(token, appName);
      const outFile = isAndroid
        ? `google-services-${app.packageName}.json`
        : `GoogleService-Info-${app.bundleId}.plist`;
      const outPath = path.resolve(__dirname, '../secrets', outFile);
      fs.writeFileSync(outPath, config);
      console.log(`  Config saved: ${outPath}`);
    } catch (e) {
      console.error(`  ERROR: ${e.message}`);
    }
  }
  console.log('\nAll done!');
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });

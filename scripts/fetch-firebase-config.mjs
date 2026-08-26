#!/usr/bin/env node
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SA_PATH = path.resolve(__dirname, '../secrets/firebase-adminsdk.json');
const sa = JSON.parse(fs.readFileSync(SA_PATH, 'utf8'));

function mintJwt(serviceAccount, scope) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: serviceAccount.client_email,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url');
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(serviceAccount.private_key, 'base64url')}`;
}

async function getAccessToken(scope) {
  const jwt = mintJwt(sa, scope);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Token error: ${JSON.stringify(json)}`);
  return json.access_token;
}

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/firebase';
const PROJECT = sa.project_id;
const BASE = 'https://firebase.googleapis.com/v1beta1';

async function api(token, endpoint) {
  const res = await fetch(`${BASE}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`API ${endpoint} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function downloadConfig(token, resourceName) {
  const res = await fetch(`${BASE}/${resourceName}/config`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Config -> ${res.status}: ${JSON.stringify(json)}`);
  return Buffer.from(json.configFileContents, 'base64').toString('utf8');
}

(async () => {
  console.log('Fetching access token for project:', PROJECT);
  const token = await getAccessToken(SCOPE);

  console.log('\nAndroid apps:');
  const androidRes = await api(token, `/projects/${PROJECT}/androidApps`);
  const androidApps = androidRes.apps ?? [];
  if (androidApps.length === 0) console.log('  (none registered)');
  for (const app of androidApps) {
    console.log(`  * ${app.displayName ?? app.appId}  [${app.packageName}]`);
    try {
      const config = await downloadConfig(token, app.name);
      const outPath = path.resolve(__dirname, `../secrets/google-services-${app.packageName}.json`);
      fs.writeFileSync(outPath, config);
      console.log(`    Saved -> ${outPath}`);
      const parsed = JSON.parse(config);
      console.log(`    project_number: ${parsed.project_info?.project_number}`);
      console.log(`    app_id: ${parsed.client?.[0]?.client_info?.mobilesdk_app_id}`);
    } catch (e) {
      console.error(`    ERROR: ${e.message}`);
    }
  }

  console.log('\niOS apps:');
  const iosRes = await api(token, `/projects/${PROJECT}/iosApps`);
  const iosApps = iosRes.apps ?? [];
  if (iosApps.length === 0) console.log('  (none registered)');
  for (const app of iosApps) {
    console.log(`  * ${app.displayName ?? app.appId}  [${app.bundleId}]`);
    try {
      const config = await downloadConfig(token, app.name);
      const outPath = path.resolve(__dirname, `../secrets/GoogleService-Info-${app.bundleId}.plist`);
      fs.writeFileSync(outPath, config);
      console.log(`    Saved -> ${outPath}`);
    } catch (e) {
      console.error(`    ERROR: ${e.message}`);
    }
  }

  console.log('\nDone.');
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });

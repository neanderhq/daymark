// Runs only against the disposable database explicitly provided to the checker.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { Client } from 'pg';
import { DEMO_EMAIL, DEMO_HOST_ID, futureWeekday, seed } from '../.neander/seed.mjs';

const exec = promisify(execFile);
const image = process.env.NEANDER_TEMPLATE_IMAGE;
const databaseUrl = process.env.NEANDER_TEMPLATE_TEST_DATABASE_URL;
assert.ok(image, 'NEANDER_TEMPLATE_IMAGE must identify the built image');
assert.ok(databaseUrl, 'An explicitly disposable NEANDER_TEMPLATE_TEST_DATABASE_URL is required');
assert.equal(process.env.DATABASE_URL, databaseUrl, 'Refusing to verify a different database');
const origin = new URL(process.env.BETTER_AUTH_URL);
assert.ok(['127.0.0.1', 'localhost'].includes(origin.hostname), 'Only local verification origins are allowed');
assert.equal(origin.protocol, 'http:');
const password = process.env.DEMO_HOST_PASSWORD;
const name = `calendly-template-check-${randomUUID().slice(0, 12)}`;
const directory = await mkdtemp(join(tmpdir(), 'calendly-template-'));
const environmentPath = join(directory, 'environment');
const runtimeDatabase = new URL(databaseUrl);
if (process.platform === 'darwin' && ['127.0.0.1', 'localhost'].includes(runtimeDatabase.hostname)) runtimeDatabase.hostname = 'host.docker.internal';
const environment = {
  DATABASE_URL: runtimeDatabase.href,
  BETTER_AUTH_URL: origin.origin,
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
  PORT: process.platform === 'linux' ? origin.port || '80' : '8080',
};
await writeFile(environmentPath, Object.entries(environment).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });
let browser;
const db = new Client({ connectionString: databaseUrl });
let connected = false;
async function ready() {
  for (let attempt = 0; attempt < 120; attempt++) {
    try { if ((await fetch(`${origin.origin}/api/health`)).ok) return; } catch {}
    await delay(500);
  }
  throw new Error('Built image did not become ready within 60 seconds');
}
async function json(response, status = 200) {
  assert.equal(response.status(), status, await response.text());
  return response.json();
}

try {
  const networking = process.platform === 'linux' ? ['--network', 'host'] : ['--publish', `127.0.0.1:${origin.port || 80}:8080`];
  await exec('docker', ['run', '--detach', '--name', name, '--env-file', environmentPath, ...networking, image], { timeout: 60000 });
  await ready();
  await exec('python3', ['scripts/test_entrypoint.py'], { timeout: 60000 });
  await exec('python3', ['scripts/smoke.py', origin.origin], { timeout: 60000 });
  await db.connect(); connected = true;
  const before = (await db.query('SELECT password FROM account WHERE user_id=$1', [DEMO_HOST_ID])).rows[0].password;
  assert.deepEqual(await seed({ databaseUrl, password }), { created: false });
  assert.equal((await db.query('SELECT count(*)::int AS count FROM contact WHERE host_id=$1', [DEMO_HOST_ID])).rows[0].count, 3);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM booking WHERE host_id=$1', [DEMO_HOST_ID])).rows[0].count, 3);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM booking WHERE host_id=$1 AND EXTRACT(HOUR FROM start_utc)=10', [DEMO_HOST_ID])).rows[0].count, 3, 'Fixture dates must stay at 10:00 UTC regardless of operator timezone');
  assert.equal((await db.query('SELECT count(*)::int AS count FROM poll_vote')).rows[0].count, 1);
  await exec('pnpm', ['exec', 'playwright', 'install', ...(process.platform === 'linux' ? ['--with-deps'] : []), 'chromium'], { timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, timezoneId: 'UTC', extraHTTPHeaders: { origin: origin.origin } });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const anonymous = await browser.newContext();
  assert.equal((await anonymous.request.get(`${origin.origin}/api/contacts`)).status(), 401);
  const publicPage = await anonymous.newPage();
  await publicPage.goto(`${origin.origin}/maya-chen/discovery-call`);
  await expect(publicPage.getByRole('heading', { name: 'Discovery call' })).toBeVisible();
  await page.goto(`${origin.origin}/login`);
  await page.getByLabel('Email address').fill(DEMO_EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page).toHaveURL(`${origin.origin}/dashboard`);
  await expect(page.getByRole('heading', { name: 'Hello, Maya.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Discovery call' })).toBeVisible();
  await expect(page.getByText(/Next: Alex Rivera,/)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  if (process.env.NEANDER_TEMPLATE_SCREENSHOT) await page.screenshot({ path: process.env.NEANDER_TEMPLATE_SCREENSHOT, fullPage: true, animations: 'disabled' });
  for (const path of ['contacts', 'bookings', 'polls', 'links', 'availability', 'event-type']) {
    const response = await page.goto(`${origin.origin}/dashboard/${path}`);
    assert.equal(response.status(), 200, `${path} must render from seeded PostgreSQL data`);
  }
  await json(await context.request.patch(`${origin.origin}/api/profile`, { headers: { origin: 'https://attacker.example' }, data: { name: 'Unwanted edit' } }), 403);
  const contacts = await json(await context.request.get(`${origin.origin}/api/contacts`));
  assert.equal(contacts.contacts.length, 3);
  assert.ok(contacts.contacts.some(contact => contact.email === 'alex.rivera@example.invalid'));
  const date = futureWeekday(12).toISOString().slice(0, 10);
  const availability = await json(await anonymous.request.get(`${origin.origin}/api/public/availability?username=maya-chen&eventSlug=discovery-call&date=${date}&tz=UTC`));
  assert.ok(availability.slots.length > 0, 'Seeded hours must offer real bookable slots');
  const booking = { username: 'maya-chen', eventSlug: 'discovery-call', startUtc: availability.slots[0], timezone: 'UTC', name: 'Casey Morgan', email: 'casey.morgan@example.invalid', answers: [] };
  await json(await anonymous.request.post(`${origin.origin}/api/public/bookings`, { data: booking }), 201);
  assert.equal((await anonymous.request.post(`${origin.origin}/api/public/bookings`, { data: booking })).status(), 409, 'Booking a taken slot must be rejected');
  await json(await context.request.patch(`${origin.origin}/api/profile`, { data: { name: 'Maya Updated', email: DEMO_EMAIL, timezone: 'UTC' } }));
  const removed = (await db.query('DELETE FROM contact WHERE id=$1 RETURNING *', ['template-calendly-contact-2'])).rows[0];
  assert.ok(removed, 'A seed contact exists to exercise preserving user deletion');
  await Promise.all([seed({ databaseUrl, password: 'replacement-not-used' }), seed({ databaseUrl, password: 'replacement-not-used' })]);
  assert.equal((await db.query('SELECT password FROM account WHERE user_id=$1', [DEMO_HOST_ID])).rows[0].password, before, 'Retry must not reset a password');
  assert.equal((await db.query('SELECT id FROM contact WHERE id=$1', [removed.id])).rowCount, 0, 'Retry must not recreate a deleted contact');
  await exec('docker', ['restart', name], { timeout: 60000 });
  await ready();
  const me = await json(await context.request.get(`${origin.origin}/api/me`));
  assert.equal(me.name, 'Maya Updated', 'A real profile edit must survive both reseeding and container restart');
  assert.equal((await db.query('SELECT id FROM booking WHERE invitee_email=$1', [booking.email])).rowCount, 1, 'A real public booking must survive restart');
  const login = await anonymous.request.post(`${origin.origin}/api/auth/sign-in/email`, { data: { email: DEMO_EMAIL, password }, headers: { origin: origin.origin } });
  await json(login);
  assert.deepEqual(pageErrors, [], 'Seeded product routes must have no browser runtime errors');
  await exec(process.execPath, ['.neander/check-auth.mjs', origin.origin], { timeout: 60000 });
  // Restore verification mutations so a second verification can use the same fixture.
  await db.query('UPDATE "user" SET name=$1 WHERE id=$2', ['Maya Chen', DEMO_HOST_ID]);
  await db.query('DELETE FROM booking WHERE host_id=$1 AND invitee_email=$2', [DEMO_HOST_ID, booking.email]);
  await db.query('DELETE FROM contact WHERE host_id=$1 AND email=$2', [DEMO_HOST_ID, booking.email]);
  await db.query('INSERT INTO contact (id,host_id,name,email,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6)', [removed.id, removed.host_id, removed.name, removed.email, removed.created_at, removed.updated_at]);
  const acceptance = await exec(process.execPath, ['scripts/test-scorecard-browser.mjs'], { timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  console.log(acceptance.stdout);
  console.log('Built-image verification passed: browser login, seeded dashboard/routes, public booking/conflict, auth validation, concurrent seed retries, preserved edits/deletions/password, and persistence after restart.');
} catch (error) {
  const logs = await exec('docker', ['logs', '--tail', '100', name]).catch(() => ({ stdout: '', stderr: '' }));
  console.error(logs.stdout, logs.stderr);
  throw error;
} finally {
  if (connected) await db.end();
  if (browser) await browser.close();
  await exec('docker', ['rm', '--force', name]).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}

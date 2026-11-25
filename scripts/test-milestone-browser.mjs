import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect, request } from '@playwright/test';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';
import { controlledProviders } from './test-milestone-providers.mjs';

const exec = promisify(execFile);
const origin = new URL(process.env.BETTER_AUTH_URL);
const image = process.env.NEANDER_TEMPLATE_IMAGE;
const databaseUrl = process.env.NEANDER_TEMPLATE_TEST_DATABASE_URL;
assert.ok(image);
assert.ok(databaseUrl);
assert.equal(process.env.DATABASE_URL, databaseUrl);
assert.equal(origin.protocol, 'http:');
assert.ok(['127.0.0.1', 'localhost'].includes(origin.hostname));
const suffix = randomUUID().slice(0, 8);
const name = `daymark-milestone-${suffix}`;
const directory = await mkdtemp(join(tmpdir(), 'daymark-milestone-'));
const evidence = resolve(process.env.DAYMARK_MILESTONE_EVIDENCE || '.cache/milestone');
await mkdir(evidence, { recursive: true });
const db = new Client({ connectionString: databaseUrl });
await db.connect();
const provider = await controlledProviders();
const checks = [];
const measurements = [];
const hosts = [];
const pageErrors = [];
const username = `milestone-${suffix}`;
const day = new Date();
day.setUTCDate(day.getUTCDate() + 14 + (8 - day.getUTCDay()) % 7);
const at = (dayOffset, hour = 9, minute = 0) => {
  const value = new Date(day);
  value.setUTCDate(value.getUTCDate() + dayOffset);
  value.setUTCHours(hour, minute, 0, 0);
  return value.toISOString();
};
const date = at(0).slice(0, 10);
const end = (start, minutes) => new Date(Date.parse(start) + minutes * 60_000).toISOString();
const busy = (start, minutes = 60) => ({ start, end: end(start, minutes), summary: 'Private provider fixture' });
const email = (label) => `${label}-${suffix}@example.invalid`;
const defaultEvent = { name: 'Project discussion', slug: 'project-discussion', durationMinutes: 30, location: 'Video call', active: true };
const shortEvent = { name: 'Project introduction', slug: 'project-intro', durationMinutes: 15, location: 'Studio 1', active: true };
const longEvent = { name: 'Project consultation', slug: 'project-consult', durationMinutes: 45, location: 'Studio 2', active: true };
const input = (slug, startUtc, label) => ({ username, eventSlug: slug, startUtc, timezone: 'UTC', name: 'Morgan Ellis', email: email(label), answers: [] });
const originHeader = { origin: origin.origin };

let browser, owner, other, visitor;
let running = false;

async function data(response, status = 200) {
  assert.equal(response.status(), status, await response.text());
  return response.json();
}

async function check(id, fn) {
  await fn();
  checks.push({ id, outcome: 'passed' });
  console.log(`PASS ${id}`);
}

async function ready() {
  for (let index = 0; index < 120; index++) {
    try { if ((await fetch(new URL('/api/health', origin))).ok) return; } catch {}
    await delay(500);
  }
  throw new Error('Milestone app did not become ready.');
}

async function restart() {
  await exec('docker', ['restart', name], { timeout: 60_000 });
  await ready();
}

async function ownerSession(label) {
  const context = await request.newContext({ baseURL: origin.origin, extraHTTPHeaders: originHeader });
  const { user } = await data(await context.post('/api/auth/sign-up/email', {
    data: { name: 'Taylor Morgan', email: email(label), password: `Fictional-${randomUUID()}`, timezone: 'UTC' },
  }));
  hosts.push(user.id);
  await context.get('/dashboard');
  return { context, id: user.id };
}

async function capture(page, path) {
  await page.screenshot({ path: join(evidence, `${path}.png`), fullPage: true, animations: 'disabled' });
}

async function fit(page, state) {
  const size = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
  assert.equal(size.viewport, 375);
  assert.ok(size.content <= 375, `${state}: ${JSON.stringify(size)}`);
  measurements.push({ state, ...size });
}

async function tabTo(page, item) {
  await expect(item).toBeVisible();
  for (let index = 0; index < 64; index++) {
    if (await item.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Keyboard could not reach ${await item.getAttribute('id') ?? await item.textContent()}`);
}

async function dates(page, day = date) {
  const expected = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));
  for (let index = 0; index < 3 && await page.locator('.calendar-nav h3').innerText() !== expected; index++) {
    const next = page.getByRole('button', { name: 'Next month', exact: true });
    await tabTo(page, next);
    await page.keyboard.press('Enter');
  }
  return page.locator(`[data-calendar-date="${day}"]`);
}

async function historicalMigration() {
  const isolated = `daymark_history_${suffix}`;
  const schemaDir = join(directory, 'historical-drizzle');
  await mkdir(join(schemaDir, 'meta'), { recursive: true });
  const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8'));
  journal.entries = journal.entries.filter(({ idx }) => idx <= 10);
  await writeFile(join(schemaDir, 'meta/_journal.json'), JSON.stringify(journal));
  for (const { tag } of journal.entries) await copyFile(`drizzle/${tag}.sql`, join(schemaDir, `${tag}.sql`));

  await db.query(`CREATE DATABASE "${isolated}"`);
  const url = new URL(databaseUrl);
  url.pathname = `/${isolated}`;
  const historical = new Client({ connectionString: url.href, options: '-c timezone=UTC' });
  try {
    await historical.connect();
    await migrate(drizzle(historical), { migrationsFolder: schemaDir });
    await historical.query(`INSERT INTO "user" (id,name,email,username,timezone) VALUES ('legacy-host','Legacy Host','legacy@example.invalid','legacy','UTC');
      INSERT INTO event_type (id,user_id,name,slug,duration_minutes) VALUES ('legacy-page','legacy-host','Legacy meeting','existing-link',30);
      INSERT INTO booking (id,host_id,event_type_id,invitee_name,invitee_email,invitee_timezone,start_utc,end_utc,confirmation_token)
      VALUES ('legacy-booking','legacy-host','legacy-page','Legacy guest','legacy-guest@example.invalid','UTC','2030-01-01 10:00','2030-01-01 10:30','legacy-token');`);
    await migrate(drizzle(historical), { migrationsFolder: 'drizzle' });
    const result = await historical.query(`SELECT u.username, e.slug, e.is_default, b.id, b.confirmation_token
      FROM "user" u JOIN event_type e ON e.user_id=u.id JOIN booking b ON b.event_type_id=e.id
      WHERE u.id='legacy-host'`);
    assert.deepEqual(result.rows, [{ username: 'legacy', slug: 'existing-link', is_default: true, id: 'legacy-booking', confirmation_token: 'legacy-token' }]);
    await historical.query("INSERT INTO event_type (id,user_id,name,slug,duration_minutes) VALUES ('another','legacy-host','Another','second-link',15)");
    await assert.rejects(historical.query("UPDATE event_type SET is_default=true WHERE id='another'"), { code: '23505' });
  } finally {
    await historical.end();
    await db.query(`DROP DATABASE "${isolated}"`);
  }
}

const availability = (slug, options = {}) => visitor.get('/api/public/availability', {
  params: { username, eventSlug: slug, date, tz: 'UTC', ...options },
});
const book = (slug, start, label) => visitor.post('/api/public/bookings', { data: input(slug, start, label) });
const authorize = async (context = owner) => {
  const result = await context.post('/api/settings/google-calendar', { maxRedirects: 0 });
  assert.equal(result.status(), 303);
  return new URL(result.headers().location);
};
const callback = (context, params) => context.get('/api/settings/google-calendar/callback', { params, maxRedirects: 0 });
const assertCallback = async (result, expected) => {
  assert.equal(result.status(), 303);
  assert.equal(result.headers().location, `/settings?calendar=${expected}#google-calendar`);
};

try {
  await check('historical-migration', historicalMigration);
  const runtimeDb = new URL(databaseUrl);
  if (process.platform === 'darwin') runtimeDb.hostname = 'host.docker.internal';
  const env = {
    DATABASE_URL: runtimeDb.href, BETTER_AUTH_URL: origin.origin, BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    PORT: process.platform === 'linux' ? origin.port : '8080',
    DAYMARK_TEST_PROVIDER_ORIGIN: provider.origin, DAYMARK_RESEND_API_KEY: 'fictional-resend',
    DAYMARK_EMAIL_FROM: 'daymark@example.invalid', DAYMARK_GOOGLE_CLIENT_ID: 'fictional-google-client',
    DAYMARK_GOOGLE_CLIENT_SECRET: 'fictional-google-secret',
  };
  const envFile = join(directory, 'runtime.env');
  await writeFile(envFile, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n')+'\n', { mode: 0o600 });
  const network = process.platform === 'linux' ? ['--network', 'host'] : ['--publish', `127.0.0.1:${origin.port}:8080`];
  await exec('docker', ['run', '--detach', '--name', name, '--env-file', envFile, ...network, image], { timeout: 60_000 });
  running = true;
  await ready();
  browser = await chromium.launch();
  const host = await ownerSession('owner');
  owner = host.context;
  other = (await ownerSession('other')).context;
  visitor = await request.newContext({ baseURL: origin.origin });
  await data(await owner.patch('/api/event-type', { data: { ...defaultEvent, username } }));
  await data(await owner.put('/api/availability/rules', { data: {
    bufferBeforeMinutes: 0, bufferAfterMinutes: 0, minimumNoticeHours: 0, bookingHorizonDays: 60,
    startTimeIncrementMinutes: 15, dailyMeetingLimit: null, weeklyMeetingLimit: null, monthlyMeetingLimit: null,
  } }));
  const long = await data(await owner.post('/api/event-type', { data: longEvent }), 201);
  const hostPhone = await browser.newContext({ storageState: await owner.storageState(), viewport: { width: 375, height: 900 },
    timezoneId: 'UTC', permissions: ['clipboard-read', 'clipboard-write'] });
  const guestPhone = await browser.newContext({ viewport: { width: 375, height: 900 }, timezoneId: 'UTC', acceptDownloads: true });
  const hostDesktop = await browser.newContext({ storageState: await owner.storageState(), viewport: { width: 1440, height: 1000 }, timezoneId: 'UTC' });
  const editor = await hostPhone.newPage();
  const guest = await guestPhone.newPage();
  const desktop = await hostDesktop.newPage();
  for (const page of [editor, guest, desktop]) page.on('pageerror', error => pageErrors.push(error.message));
  let short;

  await check('multiple-reusable-booking-pages-access', async () => {
    await editor.goto(new URL('/dashboard/event-type', origin).href);
    await tabTo(editor, editor.getByRole('link', { name: 'New booking page' }));
    await editor.keyboard.press('Enter');
    await expect(editor.getByRole('heading', { name: 'New booking page', exact: true })).toBeVisible();
    const eventName = editor.getByLabel('Event name');
    const slug = editor.getByLabel('Event URL ending');
    const location = editor.getByLabel('Location', { exact: true });
    await tabTo(editor, eventName);
    await editor.keyboard.type(shortEvent.name);
    await tabTo(editor, slug);
    await editor.keyboard.type(longEvent.slug);
    await editor.getByLabel('Duration').selectOption('15');
    await tabTo(editor, location);
    await editor.keyboard.type(shortEvent.location);
    const submit = editor.getByRole('button', { name: 'Create booking page' });
    await tabTo(editor, submit);
    await editor.keyboard.press('Enter');
    await expect(editor.getByText('Choose a unique event URL.')).toBeVisible();
    await expect(slug).toBeFocused();
    await expect(eventName).toHaveValue(shortEvent.name);
    await fit(editor, 'duplicate slug');
    await capture(editor, 'pages-duplicate-phone');
    await editor.keyboard.press('ControlOrMeta+a');
    await editor.keyboard.type(shortEvent.slug);
    await tabTo(editor, submit);
    await editor.keyboard.press('Enter');
    await expect(editor.getByRole('heading', { name: 'Edit booking page' })).toBeVisible();
    short = { ...shortEvent, id: new URL(editor.url()).searchParams.get('page') };
    assert.ok(short.id);
    const copy = editor.getByRole('button', { name: 'Copy', exact: true });
    await tabTo(editor, copy);
    await editor.keyboard.press('Enter');
    await expect(editor.getByRole('button', { name: 'Copied' })).toBeVisible();
    const url = await editor.evaluate(() => navigator.clipboard.readText());
    assert.equal(url, `${origin.origin}/${username}/${shortEvent.slug}`);
    await fit(editor, 'booking page editor');
    await guest.goto(url);
    const day = await dates(guest);
    await expect(day).toBeEnabled();
    await tabTo(guest, guest.locator('[data-calendar-date][tabindex="0"]:enabled'));
    for (let index = 0; index < 31 && !await day.evaluate(el => el === document.activeElement); index++) {
      const focusedDate = await guest.locator('[data-calendar-date]:focus').getAttribute('data-calendar-date');
      await guest.keyboard.press(focusedDate < date ? 'ArrowRight' : 'ArrowLeft');
    }
    await expect(day).toBeFocused();
    await expect(day).toHaveCSS('outline-style', 'solid');
    await guest.keyboard.press('Enter');
    const slot = guest.getByRole('button', { name: 'Choose 10:00 AM', exact: true });
    await tabTo(guest, slot);
    await guest.keyboard.press('Enter');
    const guestName = guest.getByLabel('Your name', { exact: true });
    await tabTo(guest, guestName);
    await guest.keyboard.type('Morgan Ellis');
    const guestEmail = guest.getByLabel('Email', { exact: true });
    await tabTo(guest, guestEmail);
    await guest.keyboard.type(email('phone'));
    await tabTo(guest, guest.getByRole('button', { name: 'Book meeting' }));
    await guest.keyboard.press('Enter');
    await expect(guest.getByText('Status: Confirmed')).toBeVisible();
    await fit(guest, 'secondary booking receipt');
    await capture(guest, 'pages-booking-phone');
  });

  await check('multiple-reusable-booking-pages', async () => {
    assert.equal((await owner.post('/api/event-type', { data: { ...shortEvent, slug: 'bad slug!' } })).status(), 400);
    assert.equal((await other.patch('/api/event-type', { data: short })).status(), 404);
    assert.equal((await other.get(`/dashboard/event-type?page=${short.id}`)).status(), 404);
    assert.equal((await owner.patch('/api/event-type', { data: { ...short, slug: 'changed' } })).status(), 400);
    await desktop.goto(`${origin.origin}/dashboard/event-type?page=${short.id}`);
    await expect(desktop.getByRole('navigation', { name: 'Booking pages' })).toContainText('Default');
    await expect(desktop.getByRole('navigation', { name: 'Booking pages' })).toContainText(longEvent.name);
    await expect(desktop.getByLabel('Location', { exact: true })).toHaveValue(shortEvent.location);
    await capture(desktop, 'pages-desktop');
    const [first, second] = await Promise.all([book(short.slug, at(0, 9), 'race-short'), book(long.slug, at(0, 9), 'race-long')]);
    assert.deepEqual([first.status(), second.status()].sort(), [201, 409]);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM booking WHERE host_id=$1 AND start_utc=$2', [host.id, at(0, 9)])).rows[0].count, 1);
    assert.ok((await data(await availability(long.slug))).slots.includes(at(0, 11)));
    const longer = await data(await book(long.slug, at(0, 11), 'long'), 201);
    let duration = (await db.query('SELECT extract(epoch from end_utc-start_utc)::int/60 AS duration FROM booking WHERE id=$1', [longer.id])).rows[0].duration;
    assert.equal(duration, 45);
    await data(await owner.patch('/api/event-type', { data: { ...longEvent, id: long.id, active: false, durationMinutes: 60 } }));
    assert.equal((await availability(long.slug)).status(), 404);
    assert.equal((await book(long.slug, at(0, 12), 'paused')).status(), 404);
    await guest.goto(`${origin.origin}/${username}/${long.slug}`);
    await expect(guest.getByRole('heading', { name: /booking page isn’t available/ })).toBeVisible();
    assert.ok((await data(await availability(long.slug, { rescheduleToken: longer.confirmationToken }))).slots.includes(at(0, 12)));
    await data(await visitor.post(`/api/public/bookings/${longer.confirmationToken}/reschedule`, { data: { startUtc: at(0, 12) } }));
    duration = (await db.query('SELECT extract(epoch from end_utc-start_utc)::int/60 AS duration FROM booking WHERE id=$1', [longer.id])).rows[0].duration;
    assert.equal(duration, 45);
    await data(await visitor.post(`/api/public/bookings/${longer.confirmationToken}/cancel`, { data: {} }));
  });

  let emailed;
  const delivery = async () => (await db.query('SELECT * FROM booking_email WHERE booking_id=$1 ORDER BY revision', [emailed.id])).rows;
  await check('booking-emails-calendar-download', async () => {
    provider.state.mail = 'ambiguous';
    emailed = await data(await visitor.post('/api/public/bookings', {
      data: { ...input(defaultEvent.slug, at(1, 9), 'mail'), timezone: 'America/New_York' },
    }), 201);
    provider.state.mail = 'ok';
    assert.equal((await delivery())[0].status, 'pending');
    const receipt = `${origin.origin}/booking/${emailed.confirmationToken}`;
    const ics = `/api/public/bookings/${emailed.confirmationToken}/calendar`;
    const file = await visitor.get(ics);
    assert.equal(file.status(), 200);
    assert.match(file.headers()['content-type'], /^text\/calendar/);
    const original = await file.text();
    assert.match(original, /SUMMARY:Project discussion/);
    assert.match(original, /SEQUENCE:0/);
    assert.match(original, new RegExp(at(1, 9).replace(/[-:]|\.\d{3}/g, '')));
    await guest.goto(receipt);
    await expect(guest.getByText(/email is queued/i)).toBeVisible();
    await capture(guest, 'receipt-queued-phone');

    await restart();
    await db.query("UPDATE booking_email SET next_attempt_at=NOW()-interval '1 second' WHERE booking_id=$1", [emailed.id]);
    assert.equal((await data(await other.post('/api/settings/booking-emails'))).attempted, 0);
    assert.equal((await visitor.post('/api/settings/booking-emails', { headers: originHeader })).status(), 401);
    await Promise.all([owner.post('/api/settings/booking-emails'), owner.post('/api/settings/booking-emails')]);
    assert.equal((await delivery())[0].status, 'accepted');
    const records = provider.state.attempts.filter(({ payload }) => payload.to[0] === email('mail'));
    assert.equal(records.length, 2);
    assert.equal(records[0].key, records[1].key);
    assert.match(records[0].payload.text, /4:00 AM.*America\/New_York/);
    assert.ok(records[0].payload.text.includes(receipt));
    assert.equal([...provider.state.deliveries.values()].filter(({ payload }) => payload.to[0] === email('mail')).length, 1);
    await data(await visitor.post(`/api/public/bookings/${emailed.confirmationToken}/reschedule`, { data: { startUtc: at(1, 10) } }));
    const rescheduled = await (await visitor.get(ics)).text();
    assert.equal(rescheduled.match(/^UID:.*$/m)[0], original.match(/^UID:.*$/m)[0]);
    assert.match(rescheduled, /SEQUENCE:1/);
    assert.match(rescheduled, new RegExp(at(1, 10).replace(/[-:]|\.\d{3}/g, '')));
    assert.equal((await visitor.get('/api/public/bookings/invalid/calendar')).status(), 404);
    await desktop.goto(receipt);
    await expect(desktop.getByText(/email service accepted/i)).toBeVisible();
    await capture(desktop, 'receipt-calendar-desktop');
  });

  await check('booking-emails-calendar-download-access', async () => {
    const receipt = `${origin.origin}/booking/${emailed.confirmationToken}`;
    const ics = `/api/public/bookings/${emailed.confirmationToken}/calendar`;
    await guest.goto(receipt);
    const download = guest.getByRole('link', { name: 'Download calendar file' });
    await tabTo(guest, download);
    const downloading = guest.waitForEvent('download');
    await guest.keyboard.press('Enter');
    assert.equal((await downloading).suggestedFilename(), 'daymark.ics');
    await fit(guest, 'calendar download receipt');
    await capture(guest, 'receipt-download-phone');
    await data(await visitor.post(`/api/public/bookings/${emailed.confirmationToken}/cancel`, { data: {} }));
    assert.equal((await visitor.get(ics)).status(), 404);
    await guest.reload();
    await expect(guest.getByText('Status: Cancelled')).toBeVisible();
    await expect(download).toHaveCount(0);
    assert.deepEqual((await delivery()).map(({ kind, status }) => [kind, status]),
      [['confirmed', 'accepted'], ['rescheduled', 'accepted'], ['cancelled', 'accepted']]);
    const delivered = [...provider.state.deliveries.values()].filter(({ payload }) => payload.to[0] === email('mail'));
    assert.equal(delivered.length, 3);
    assert.ok(delivered.every(({ payload }) => payload.text.includes(receipt)));
    assert.match(delivered[1].payload.subject, /rescheduled/);
    assert.match(delivered[2].payload.subject, /cancelled/);
  });

  await check('google-calendar-conflict-checks', async () => {
    const denied = await authorize();
    await assertCallback(await callback(owner, { state: denied.searchParams.get('state'), error: 'access_denied' }), 'denied');
    assert.equal((await db.query('SELECT 1 FROM google_calendar_connection WHERE host_id=$1', [host.id])).rowCount, 0);

    const authorization = await authorize();
    const params = { state: authorization.searchParams.get('state'), code: provider.issueCode(authorization) };
    await assertCallback(await callback(other, params), 'invalid');
    await assertCallback(await callback(owner, params), 'connected');
    await assertCallback(await callback(owner, params), 'invalid');
    assert.equal(provider.state.exchanged, 1);
    const connector = (await db.query('SELECT * FROM google_calendar_connection WHERE host_id=$1', [host.id])).rows[0];
    assert.ok(connector.refresh_cipher && !connector.refresh_cipher.includes('fixture-refresh'));
    await restart();
    await desktop.goto(`${origin.origin}/settings`);
    await expect(desktop.getByText(/Primary calendar connected/i)).toBeVisible();
    await capture(desktop, 'calendar-connected-desktop');
    assert.equal((await other.delete('/api/settings/google-calendar')).status(), 204);
    assert.equal((await visitor.delete('/api/settings/google-calendar', { headers: originHeader })).status(), 401);

    const today = at(2).slice(0, 10);
    const before = provider.state.busyRequests.length;
    provider.state.busy = [busy(at(2, 9))];
    const month = await data(await visitor.get('/api/public/availability', {
      params: { username, eventSlug: defaultEvent.slug, month: today.slice(0, 7), tz: 'UTC' },
    }));
    assert.equal(provider.state.busyRequests.length - before, 1);
    assert.equal(month.days[today].includes(at(2, 9)), false);
    assert.ok(month.days[today].includes(at(2, 11)));
    assert.doesNotMatch(JSON.stringify(month), /private-provider-address|Private provider fixture/);
    provider.state.busy = [];
    assert.ok((await data(await availability(defaultEvent.slug, { date: today }))).slots.includes(at(2, 10)));
    provider.state.busy = [busy(at(2, 10))];
    assert.equal((await book(defaultEvent.slug, at(2, 10), 'stale')).status(), 409);
    const existing = await data(await book(defaultEvent.slug, at(2, 11), 'calendar-existing'), 201);
    const changed = await visitor.post(`/api/public/bookings/${existing.confirmationToken}/reschedule`, { data: { startUtc: at(2, 10) } });
    assert.equal(changed.status(), 409);
    assert.equal((await db.query("SELECT start_utc AT TIME ZONE 'UTC' AS start_utc FROM booking WHERE id=$1", [existing.id])).rows[0].start_utc.toISOString(), at(2, 11));

    const link = await data(await owner.post('/api/booking-links', {
      data: { kind: 'one_off', name: 'One-off review', durationMinutes: 30, proposedStarts: [at(3, 10), at(3, 11)] },
    }), 201);
    provider.state.busy = [busy(at(3, 10))];
    const linkAvailability = await data(await visitor.get(`/api/public/booking-links/${link.token}/availability`, { params: { date: at(3).slice(0, 10), tz: 'UTC' } }));
    assert.deepEqual(linkAvailability.slots, [at(3, 11)]);
    provider.state.busy = [busy(at(3, 11))];
    assert.equal((await visitor.post(`/api/public/booking-links/${link.token}`, {
      data: { name: 'Morgan Ellis', email: email('one-off'), timezone: 'UTC', startUtc: at(3, 11), answers: [] },
    })).status(), 409);
    assert.equal((await db.query('SELECT status FROM booking_link WHERE id=$1', [link.id])).rows[0].status, 'active');

    const poll = await data(await owner.post('/api/polls', {
      data: { title: 'Planning window', durationMinutes: 30, showVotes: false, options: [at(4, 9), at(4, 10)] },
    }), 201);
    provider.state.busy = [busy(at(4, 9))];
    assert.equal((await owner.post(`/api/polls/${poll.id}/book`, { data: { startUtc: at(4, 9) } })).status(), 409);
    assert.equal((await db.query('SELECT status FROM poll WHERE id=$1', [poll.id])).rows[0].status, 'open');
    provider.state.busy = [];
    const finalized = await data(await owner.post(`/api/polls/${poll.id}/book`, { data: { startUtc: at(4, 9) } }), 201);
    const resultMail = [...provider.state.deliveries.values()].find(({ payload }) => payload.subject === 'Booking confirmed: Planning window');
    assert.ok(resultMail.payload.text.includes(`/polls/${poll.token}`));
    assert.ok(!resultMail.payload.text.includes(finalized.confirmationToken));
  });

  await check('google-calendar-conflict-checks-access', async () => {
    provider.state.calendar = 'outage';
    await guest.goto(`${origin.origin}/${username}/${defaultEvent.slug}`);
    await expect(guest.getByText(/host’s calendar is temporarily unavailable/i)).toBeVisible();
    await expect(guest.getByText(/No available days this month/)).toHaveCount(0);
    assert.equal((await book(defaultEvent.slug, at(2, 15), 'outage')).status(), 503);
    await fit(guest, 'calendar service outage');
    await capture(guest, 'calendar-outage-phone');
    const retry = guest.getByRole('button', { name: 'Try again' });
    await tabTo(guest, retry);
    provider.state.calendar = 'ok';
    await guest.keyboard.press('Enter');
    await expect(retry).toHaveCount(0);

    await db.query("UPDATE google_calendar_connection SET access_expires_at=NOW()-interval '5 minutes' WHERE host_id=$1", [host.id]);
    assert.equal((await availability(defaultEvent.slug)).status(), 200);
    assert.equal(provider.state.refreshed, 1);
    provider.state.revoked = true;
    await db.query("UPDATE google_calendar_connection SET access_expires_at=NOW()-interval '5 minutes' WHERE host_id=$1", [host.id]);
    assert.equal((await availability(defaultEvent.slug)).status(), 503);
    assert.equal(provider.state.refreshed, 2);
    await editor.goto(`${origin.origin}/settings`);
    await expect(editor.getByText(/Reconnect Google Calendar before new bookings/i)).toBeVisible();
    const reconnect = editor.getByRole('button', { name: 'Reconnect Google Calendar' });
    await tabTo(editor, reconnect);
    await expect(reconnect).toBeFocused();
    await fit(editor, 'calendar reconnect settings');
    await capture(editor, 'calendar-reconnect-phone');
    provider.state.revoked = false;
    const authorization = await authorize();
    await assertCallback(await callback(owner, { state: authorization.searchParams.get('state'), code: provider.issueCode(authorization) }), 'connected');
    assert.equal((await availability(defaultEvent.slug)).status(), 200);
    await editor.reload();
    const disconnect = editor.getByRole('button', { name: 'Disconnect and use manual availability' });
    await tabTo(editor, disconnect);
    await editor.keyboard.press('Enter');
    await expect(editor.getByText('Using manual availability.')).toBeVisible();
    assert.equal((await db.query('SELECT 1 FROM google_calendar_connection WHERE host_id=$1', [host.id])).rowCount, 0);
  });

  assert.deepEqual(pageErrors, []);
} catch (error) {
  console.error(error);
  if (running) {
    const logs = await exec('docker', ['logs', '--tail', '120', name]).catch(() => null);
    console.error(logs?.stdout, logs?.stderr);
  }
  throw error;
} finally {
  await writeFile(join(evidence, 'report.json'), JSON.stringify({ checks, viewport_measurements: measurements, page_errors: pageErrors }, null, 2)+'\n');
  for (const context of [owner, other, visitor]) await context?.dispose();
  for (const id of hosts) await db.query('DELETE FROM "user" WHERE id=$1', [id]);
  await db.end();
  if (browser) await browser.close();
  if (running) await exec('docker', ['rm', '--force', name]).catch(() => {});
  provider.close();
  await rm(directory, { recursive: true, force: true });
}

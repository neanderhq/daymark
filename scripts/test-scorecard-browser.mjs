// Real application acceptance for the ten Daymark v1 journeys. Fictional actors only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect, request } from '@playwright/test';
import { Client } from 'pg';

const origin = process.env.BETTER_AUTH_URL;
assert.ok(origin && ['127.0.0.1', 'localhost'].includes(new URL(origin).hostname));
assert.equal(process.env.DATABASE_URL, process.env.NEANDER_TEMPLATE_TEST_DATABASE_URL);
const directory = resolve(process.env.DAYMARK_SCORECARD_EVIDENCE || '.cache/scorecard');
await mkdir(directory, { recursive: true });
const checks = [];
const errors = [];
const viewportMeasurements = [];
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const browser = await chromium.launch();
const owner = await request.newContext({ baseURL: origin, extraHTTPHeaders: { origin } });
const anonymous = await request.newContext({ baseURL: origin, extraHTTPHeaders: { origin } });
const suffix = randomUUID().slice(0, 8);
const username = `lab-${suffix}`;
const email = `host-${suffix}@example.invalid`;
const password = `Local-only-${randomUUID()}`;
let hostId;

async function json(response, status = 200) {
  assert.equal(response.status(), status, await response.text());
  return response.json();
}
async function check(id, run) {
  try { await run(); checks.push({ id, outcome: 'passed' }); console.log(`PASS ${id}`); }
  catch (error) { checks.push({ id, outcome: 'failed', error: error.message }); throw error; }
}
async function capture(page, name) {
  await page.screenshot({ path: `${directory}/${name}.png`, fullPage: true, animations: 'disabled' });
}
async function fits(page, width) {
  const size = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
  viewportMeasurements.push({ path: new URL(page.url()).pathname, ...size });
  assert.equal(size.viewport, width);
  assert.ok(size.content <= width, JSON.stringify(size));
}
const day = new Date();
day.setUTCDate(day.getUTCDate() + 14 + (8 - day.getUTCDay()) % 7);
day.setUTCHours(0, 0, 0, 0);
const date = day.toISOString().slice(0, 10);
const dateAt = (offset, hour = 9, minute = 0) => {
  const value = new Date(day); value.setUTCDate(value.getUTCDate() + offset); value.setUTCHours(hour, minute);
  return value.toISOString();
};
const rules = { bufferBeforeMinutes: 0, bufferAfterMinutes: 0, minimumNoticeHours: 0,
  bookingHorizonDays: 60, startTimeIncrementMinutes: 30, dailyMeetingLimit: null, weeklyMeetingLimit: null, monthlyMeetingLimit: null };
const saveRules = async changes => json(await owner.put('/api/availability/rules', { data: { ...rules, ...changes } }));
const slots = async (d = date, tz = 'UTC', extra = {}) => (await json(await anonymous.get('/api/public/availability', {
  params: { username, eventSlug: 'discovery-call', date: d, tz, ...extra },
}))).slots;
const slotLabel = (start, timeZone) => new Intl.DateTimeFormat('en-US', {
  hour: 'numeric', minute: '2-digit', timeZone,
}).format(new Date(start));
const bookingInput = (start, name = 'Alex Morgan', timezone = 'UTC') => ({ username, eventSlug: 'discovery-call', startUtc: start,
  timezone, name, email: `${name.toLowerCase().replaceAll(' ', '-')}-${suffix}@example.invalid`, answers: [] });
const book = async (start, name, timezone) => json(await anonymous.post('/api/public/bookings', { data: bookingInput(start, name, timezone) }), 201);
const cancel = async b => json(await anonymous.post(`/api/public/bookings/${b.confirmationToken}/cancel`, { data: { reason: 'Fictional acceptance completed.' } }));
const publicPath = `/${username}/discovery-call`;
async function chooseDate(page, d = date) {
  const label = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`));
  for (let i = 0; i < 3 && await page.locator('.calendar-nav h3').innerText() !== label; i++) {
    await page.getByRole('button', { name: 'Next month', exact: true }).click();
  }
  const button = page.locator(`[data-calendar-date="${d}"]`);
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByRole('button', { name: /^Choose \d/ }).first()).toBeVisible();
}

try {
  const signup = await json(await owner.post('/api/auth/sign-up/email', { data: { name: 'Taylor Morgan', email, password, timezone: 'UTC' } }));
  hostId = signup.user.id;
  await owner.get('/dashboard'); // Normal provisioning of the host's scheduling defaults.
  await json(await owner.patch('/api/event-type', { data: { name: 'Discovery call', description: 'A fictional project conversation.',
    durationMinutes: 30, location: 'Video call', slug: 'discovery-call', active: true, username } }));
  await json(await owner.put('/api/availability', { data: { ranges: [1, 2, 3, 4, 5].map(weekday => ({ weekday, startMinute: 540, endMinute: 1020 })) } }));
  await saveRules({});
  const host = await browser.newContext({ storageState: await owner.storageState(), viewport: { width: 1440, height: 1000 }, timezoneId: 'UTC' });
  const page = await host.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));

  await check('host-and-event', async () => {
    await page.goto(`${origin}/dashboard/event-type`);
    await page.getByLabel('Event name', { exact: true }).fill('Project conversation');
    await page.getByRole('button', { name: 'Save event type', exact: true }).click();
    await expect.poll(async () => (await db.query('SELECT name FROM event_type WHERE user_id=$1', [hostId])).rows[0].name).toBe('Project conversation');
    await page.reload();
    await expect(page.getByLabel('Event name', { exact: true })).toHaveValue('Project conversation');
  });

  let booking;
  await check('availability', async () => {
    assert.equal((await slots()).length, 16);
    await json(await owner.put('/api/availability/overrides', { data: { date, unavailable: true, ranges: [] } }));
    assert.deepEqual(await slots(), []);
    await json(await owner.put('/api/availability/overrides', { data: { date, unavailable: false, ranges: [{ startMinute: 600, endMinute: 720 }] } }));
    assert.deepEqual(await slots(), [dateAt(0, 10), dateAt(0, 10, 30), dateAt(0, 11), dateAt(0, 11, 30)]);
    booking = await book(dateAt(0, 10), 'Availability guest');
    await saveRules({ bufferAfterMinutes: 30 });
    assert.ok(!(await slots()).includes(dateAt(0, 10, 30)));
    assert.ok((await slots()).includes(dateAt(0, 11)));
    await saveRules({ dailyMeetingLimit: 1 }); assert.deepEqual(await slots(), []);
    await saveRules({ weeklyMeetingLimit: 1 }); assert.deepEqual(await slots(dateAt(1).slice(0, 10)), []);
    const offset = Number(date.slice(-2)) >= 28 ? -3 : 1;
    await saveRules({ monthlyMeetingLimit: 1 }); assert.deepEqual(await slots(dateAt(offset).slice(0, 10)), []);
    await saveRules({ minimumNoticeHours: 720 }); assert.deepEqual(await slots(), []);
    await saveRules({ bookingHorizonDays: 7 }); assert.deepEqual(await slots(), []);
    await saveRules({}); await cancel(booking);
    await json(await owner.delete('/api/availability/overrides', { data: { date } }));
    const month = await json(await anonymous.get('/api/public/availability', { params: { username, eventSlug: 'discovery-call', month: date.slice(0, 7), tz: 'UTC' } }));
    assert.deepEqual(month.days[date], await slots());
    assert.equal((await anonymous.get('/api/public/availability', { params: { username, eventSlug: 'discovery-call', month: '2026-13', tz: 'UTC' } })).status(), 400);
  });

  const visitor = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'UTC' });
  const invitee = await visitor.newPage();
  invitee.setDefaultTimeout(20000);
  invitee.on('pageerror', error => errors.push(error.message));
  await check('timezones', async () => {
    const expected = await slots();
    for (const tz of ['UTC', 'Asia/Kolkata', 'America/New_York']) {
      assert.deepEqual(await slots(date, tz), expected);
      const month = await json(await anonymous.get('/api/public/availability', {
        params: { username, eventSlug: 'discovery-call', month: date.slice(0, 7), tz },
      }));
      assert.deepEqual(month.days[date], expected, `Month availability must preserve the slots in ${tz}`);
      await invitee.goto(origin + publicPath);
      await expect(invitee.getByLabel('Time zone', { exact: true })).toBeVisible();
      await invitee.getByLabel('Time zone', { exact: true }).fill(tz);
      await invitee.getByLabel('Time zone', { exact: true }).press('Tab');
      await chooseDate(invitee);
      await expect(invitee.getByRole('button', { name: `Choose ${slotLabel(dateAt(0), tz)}`, exact: true })).toBeVisible();
    }
    booking = await book(dateAt(0), 'Timezone guest', 'America/New_York');
    const row = (await db.query('SELECT invitee_timezone,start_utc::text FROM booking WHERE id=$1', [booking.id])).rows[0];
    assert.equal(row.invitee_timezone, 'America/New_York'); assert.ok(row.start_utc.startsWith(`${date} 09:00`));
    await invitee.goto(`${origin}/booking/${booking.confirmationToken}`);
    await expect(invitee.getByText('America/New_York', { exact: true })).toBeVisible();
  });
  await check('public-booking', async () => {
    assert.equal((await anonymous.post('/api/public/bookings', { data: bookingInput(dateAt(0), 'Duplicate guest') })).status(), 409);
    await page.goto(`${origin}/dashboard/bookings`);
    await expect(page.getByRole('heading', { name: 'Timezone guest', exact: true })).toBeVisible();
    await invitee.reload(); await expect(invitee.getByText('Status: Confirmed')).toBeVisible();
  });
  await check('reschedule', async () => {
    await json(await owner.post(`/api/bookings/${booking.id}/reschedule`, { data: { startUtc: dateAt(0, 11) } }));
    assert.ok((await slots()).includes(dateAt(0))); assert.ok(!(await slots()).includes(dateAt(0, 11)));
    await invitee.reload();
    await invitee.getByRole('button', { name: 'Reschedule', exact: true }).click();
    await invitee.getByRole('button', { name: 'Keep current time', exact: true }).click();
    await expect(invitee.getByText('Status: Confirmed')).toBeVisible();
    await invitee.getByRole('button', { name: 'Reschedule', exact: true }).click();
    await chooseDate(invitee);
    await capture(invitee, 'reschedule');
    await invitee.getByRole('button', { name: `Choose ${slotLabel(dateAt(0, 12), 'America/New_York')}`, exact: true }).click();
    await invitee.getByRole('button', { name: 'Confirm new time', exact: true }).click();
    await expect(invitee.getByRole('button', { name: 'Reschedule', exact: true })).toBeVisible();
    assert.ok((await slots()).includes(dateAt(0, 11))); assert.ok(!(await slots()).includes(dateAt(0, 12)));
    const row = (await db.query('SELECT start_utc::text,reschedule_history FROM booking WHERE id=$1', [booking.id])).rows[0];
    assert.ok(row.start_utc.startsWith(`${date} 12:00`)); assert.equal(row.reschedule_history.length, 2);
    await invitee.reload(); await expect(invitee.getByText('Status: Confirmed')).toBeVisible();
    await invitee.getByText('Previous times (2)', { exact: true }).click();
    await capture(invitee, 'confirmation');
  });
  await check('cancel', async () => {
    await invitee.getByRole('button', { name: 'Cancel booking', exact: true }).click();
    await invitee.getByRole('button', { name: 'Keep booking', exact: true }).click();
    await expect(invitee.getByText('Status: Confirmed')).toBeVisible();
    await invitee.getByRole('button', { name: 'Cancel booking', exact: true }).click();
    await invitee.getByLabel('Reason (optional)', { exact: true }).fill('Fictional acceptance completed.');
    await capture(invitee, 'cancel-choice');
    await invitee.getByRole('button', { name: 'Confirm cancellation', exact: true }).click();
    await expect(invitee.getByText('Status: Cancelled')).toBeVisible();
    await invitee.reload(); await expect(invitee.getByText('Status: Cancelled')).toBeVisible();
    assert.ok((await slots()).includes(dateAt(0, 12)));
    const other = await book(dateAt(0, 13), 'Host cancellation');
    await json(await owner.post(`/api/bookings/${other.id}/cancel`, { data: { reason: 'Host test cancellation' } }));
    assert.ok((await slots()).includes(dateAt(0, 13)));
    const cancelled = (await db.query('SELECT cancellation_actor FROM booking WHERE id=ANY($1)', [[booking.id, other.id]])).rows;
    assert.deepEqual(cancelled.map(row => row.cancellation_actor).sort(), ['host', 'invitee']);
    await capture(invitee, 'cancelled');
  });
  await check('meeting-poll', async () => {
    const poll = await json(await owner.post('/api/polls', { data: { title: 'Project planning', description: 'Fictional planning poll', durationMinutes: 30, showVotes: true, options: [dateAt(2, 10), dateAt(2, 11)] } }), 201);
    const pub = await json(await anonymous.get(`/api/public/polls/${poll.token}`));
    await json(await anonymous.post(`/api/public/polls/${poll.token}/vote`, { data: { name: 'Jordan Lee', email: `poll-${suffix}@example.invalid`, optionIds: [pub.options[0].id] } }), 201);
    assert.equal((await json(await anonymous.get(`/api/public/polls/${poll.token}`))).votes[0].name, 'Jordan Lee');
    await json(await owner.post(`/api/polls/${poll.id}/book`, { data: { startUtc: dateAt(2, 10) } }), 201);
    const final = await json(await anonymous.get(`/api/public/polls/${poll.token}`));
    assert.equal(final.status, 'closed'); assert.equal(final.booking.startUtc, dateAt(2, 10));
    await invitee.goto(`${origin}/polls/${poll.token}`);
    await expect(invitee.getByText(/booked/i).first()).toBeVisible();
    await capture(invitee, 'poll-booked');
  });
  await check('one-off-links', async () => {
    const link = await json(await owner.post('/api/booking-links', { data: { kind: 'one_off', name: 'Project review', durationMinutes: 30, description: 'Fictional review', location: 'Video call', proposedStarts: [dateAt(4, 10), dateAt(4, 11)] } }), 201);
    await invitee.goto(origin + link.publicPath);
    await expect(invitee.getByRole('heading', { name: 'Project review', exact: true })).toBeVisible();
    const availability = await json(await anonymous.get(`/api/public/booking-links/${link.token}/availability`, { params: { date: dateAt(4).slice(0, 10), tz: 'UTC' } }));
    assert.equal(availability.slots.length, 2);
    await chooseDate(invitee, dateAt(4).slice(0, 10));
    await expect(invitee.getByRole('button', { name: /^Choose \d/ })).toHaveCount(2);
    await invitee.getByRole('button', { name: 'Choose 10:00 AM', exact: true }).click();
    await invitee.getByLabel('Your name', { exact: true }).fill('Casey Chen');
    await invitee.getByLabel('Email', { exact: true }).fill(`link-${suffix}@example.invalid`);
    await invitee.getByRole('button', { name: 'Book meeting', exact: true }).click();
    await expect(invitee).toHaveURL(/\/booking\//);
    await expect(invitee.getByText('Status: Confirmed')).toBeVisible();
    assert.equal((await anonymous.get(`/api/public/booking-links/${link.token}`)).status(), 410);
    await invitee.goto(origin + link.publicPath); await expect(invitee.getByText('This link has already been used', { exact: true })).toBeVisible();
  });
  await check('dashboard-data', async () => {
    await page.goto(`${origin}/dashboard`);
    const count = (await db.query('SELECT count(*)::int AS count FROM contact WHERE host_id=$1', [hostId])).rows[0].count;
    assert.ok(count > 0);
    const card = page.locator('.dashboard-card').filter({ has: page.getByRole('heading', { name: 'Contacts', exact: true }) });
    await expect(card.getByRole('heading', { name: `${count} contacts`, exact: true })).toBeVisible();
    await expect(card.getByText('Nothing here yet')).toHaveCount(0);
    await capture(page, 'dashboard-desktop');
    await page.goto(`${origin}/dashboard/contacts`); await capture(page, 'contacts-desktop');
  });

  await invitee.goto(origin + publicPath); await chooseDate(invitee); await capture(invitee, 'booking-desktop');
  await invitee.getByRole('button', { name: /^Choose \d/ }).first().click();
  await expect(invitee.getByRole('heading', { name: 'Your details', exact: true })).toBeFocused();
  await capture(invitee, 'details-desktop');
  await invitee.getByLabel('Your name', { exact: true }).fill('Retained draft');
  await invitee.getByRole('button', { name: 'Choose another time', exact: true }).click();
  await expect(invitee.getByRole('heading', { name: 'Choose a date and time', exact: true })).toBeFocused();
  await invitee.getByRole('button', { name: /^Choose \d/ }).first().click();
  await expect(invitee.getByLabel('Your name', { exact: true })).toHaveValue('Retained draft');
  const phone = await browser.newContext({ viewport: { width: 375, height: 900 }, timezoneId: 'UTC' });
  const small = await phone.newPage(); small.setDefaultTimeout(20000);
  small.on('pageerror', error => errors.push(error.message));
  await check('mobile-booking', async () => {
    await small.goto(origin + publicPath); await chooseDate(small); await fits(small, 375); await capture(small, 'booking-phone');
    await small.getByRole('button', { name: /^Choose \d/ }).first().click();
    await expect(small.getByRole('heading', { name: 'Your details', exact: true })).toBeFocused();
    await fits(small, 375); await capture(small, 'details-phone');
    await small.getByRole('button', { name: 'Book meeting', exact: true }).click();
    await expect(small.getByLabel('Your name', { exact: true })).toBeFocused();
    assert.ok(await small.getByLabel('Your name', { exact: true }).evaluate(el => el.validationMessage.length > 0));
    await small.getByLabel('Your name', { exact: true }).fill('Phone guest');
    await small.getByLabel('Email', { exact: true }).fill('not-an-email');
    await small.getByRole('button', { name: 'Book meeting', exact: true }).click();
    await expect(small.getByLabel('Email', { exact: true })).toBeFocused();
    assert.ok(small.url().endsWith(publicPath));
    await small.getByLabel('Email', { exact: true }).fill(`phone-${suffix}@example.invalid`);
    await small.getByRole('button', { name: 'Book meeting', exact: true }).click();
    await expect(small).toHaveURL(/\/booking\//); await expect(small.getByText('Status: Confirmed')).toBeVisible();
    await fits(small, 375); await capture(small, 'confirmation-phone');
    await small.reload(); await expect(small.getByText('Status: Confirmed')).toBeVisible();
  });
  checks.push({ id: 'phone-booking', outcome: 'passed' }, { id: 'validation-focus', outcome: 'passed' });
  await check('phone-host', async () => {
    await page.setViewportSize({ width: 375, height: 900 });
    for (const route of ['dashboard', 'dashboard/event-type', 'dashboard/availability', 'dashboard/contacts']) {
      await page.goto(`${origin}/${route}`); await fits(page, 375);
      await capture(page, route.replaceAll('/', '-') + '-phone');
    }
  });
  await check('keyboard-booking', async () => {
    await invitee.goto(origin + publicPath);
    await expect(invitee.locator('.calendar-day:enabled').first()).toBeVisible();
    async function tabTo(predicate) {
      for (let i = 0; i < 45; i++) {
        await invitee.keyboard.press('Tab');
        if (await invitee.evaluate(predicate)) return;
      }
      throw new Error('Keyboard target could not be reached');
    }
    await tabTo(() => document.activeElement?.hasAttribute('data-calendar-date'));
    await expect(invitee.locator('[data-calendar-date]:focus-visible')).toHaveCSS('outline-style', 'solid');
    await capture(invitee, 'keyboard-date');
    await invitee.keyboard.press('ArrowRight'); await invitee.keyboard.press('Enter');
    await tabTo(() => document.activeElement?.getAttribute('aria-label')?.startsWith('Choose '));
    await expect(invitee.locator('.time-button:focus-visible')).toHaveCSS('outline-style', 'solid');
    await invitee.keyboard.press('Enter');
    await expect(invitee.getByRole('heading', { name: 'Your details', exact: true })).toBeFocused();
    await invitee.keyboard.press('Tab'); await expect(invitee.getByLabel('Your name', { exact: true })).toBeFocused();
    await invitee.keyboard.type('Keyboard guest'); await invitee.keyboard.press('Tab');
    await invitee.keyboard.type(`keyboard-${suffix}@example.invalid`);
    await tabTo(() => document.activeElement?.textContent === 'Book meeting');
    await invitee.keyboard.press('Enter'); await expect(invitee).toHaveURL(/\/booking\//);
    await expect(invitee.getByText('Status: Confirmed')).toBeVisible();
  });
  assert.deepEqual(errors, []);
  console.log(`DAYMARK_SCORECARD_PASSED ${checks.length} checks; evidence=${directory}`);
} finally {
  await writeFile(`${directory}/report.json`, JSON.stringify({ observed_at: new Date().toISOString(), checks, errors, viewport_measurements: viewportMeasurements }, null, 2) + '\n');
  if (hostId) await db.query('DELETE FROM "user" WHERE id=$1', [hostId]);
  await owner.dispose(); await anonymous.dispose(); await browser.close(); await db.end();
}

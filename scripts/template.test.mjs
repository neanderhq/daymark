import assert from 'node:assert/strict';
import test from 'node:test';
import { availabilityDates, availabilityPayload } from '../server/calendar-availability.ts';
import { getDateInTimezone, isIanaTimezone, zonedWallTimeToUtc } from '../server/timezone.ts';
import { futureWeekday, seed } from '../.neander/seed.mjs';

test('seed rejects missing configuration before contacting a database', async () => {
  await assert.rejects(seed({}), /DATABASE_URL/);
});

test('sample meetings use UTC workdays across weekends and year boundaries', () => {
  assert.equal(futureWeekday(2, new Date('2026-12-31T23:59:00-08:00')).toISOString(), '2027-01-04T10:00:00.000Z');
  assert.equal(futureWeekday(2, new Date('2026-11-06T23:00:00Z')).toISOString(), '2026-11-09T10:00:00.000Z');
});


test('availability accepts real calendar dates and complete leap-aware months', () => {
  const dates = availabilityDates(new URLSearchParams({ month: '2028-02' }));
  assert.equal(dates.length, 29);
  assert.equal(dates.at(-1), '2028-02-29');
  assert.deepEqual(availabilityDates(new URLSearchParams({ date: '2028-02-29' })), ['2028-02-29']);
  for (const query of [{ month: '2026-13' }, { month: '2026-00' }, { date: '2026-02-29' },
    { month: '2026-12', date: '2026-12-01' }, {}]) {
    assert.equal(availabilityDates(new URLSearchParams(query)), null);
  }
});

test('month availability preserves the individual date slot results', async () => {
  const dates = ['2026-12-14', '2026-12-15'];
  const load = async date => date === dates[0] ? [new Date(`${date}T09:00:00Z`)] : [];
  const month = await availabilityPayload(dates, true, load);
  for (const date of dates) {
    const day = await availabilityPayload([date], false, load);
    assert.deepEqual(month.days[date], day.slots);
  }
});

test('repeated time-zone lookups preserve local dates and daylight-saving rules', () => {
  assert.equal(isIanaTimezone('UTC'), true);
  assert.equal(isIanaTimezone('America/New_York'), true);
  assert.equal(isIanaTimezone('Asia/Kolkata'), true);
  assert.equal(isIanaTimezone('Invalid/Zone'), false);
  assert.equal(isIanaTimezone('+01:00'), false);
  for (let i = 0; i < 2; i++) {
    const instant = new Date('2026-12-14T00:00:00.000Z');
    assert.equal(getDateInTimezone(instant, 'America/New_York'), '2026-12-13');
    assert.equal(getDateInTimezone(instant, 'Asia/Kolkata'), '2026-12-14');
    assert.equal(zonedWallTimeToUtc('2026-03-08', 150, 'America/New_York'), null);
    assert.equal(zonedWallTimeToUtc('2026-11-01', 90, 'America/New_York').toISOString(), '2026-11-01T05:30:00.000Z');
  }
});

test('calendar snapshots escape event fields and fold UTF-8 lines', async () => {
  const { calendarFile } = await import('../server/calendar-file.ts');
  const start = new Date('2026-12-14T15:00:00Z');
  const result = calendarFile({
    id: 'fictional-booking', start, end: new Date('2026-12-14T15:15:00Z'), stamp: start, revision: 2,
    name: 'Research 👋 '.repeat(10), location: 'Room A, floor 2; entrance\\west\nDESCRIPTION:unexpected',
  });
  assert.ok(result.split('\r\n').every(line => Buffer.byteLength(line) <= 75));
  assert.match(result, /UID:fictional-booking@daymark\r\n/);
  assert.match(result, /DTEND:20261214T151500Z\r\nSEQUENCE:2\r\n/);
  assert.ok(result.replaceAll('\r\n ', '').includes('LOCATION:Room A\\, floor 2\\; entrance\\\\west\\nDESCRIPTION:unexpected'));
  assert.doesNotMatch(result, /\r\nDESCRIPTION:/);
});


test('profile photos reject active HTML/SVG and accept supported image signatures', async () => {
  const {photoContentType}=await import('../server/profile-photo.ts');
  assert.equal(photoContentType(Buffer.from('<svg onload="alert(1)"></svg>')),null);
  assert.equal(photoContentType(Buffer.from('<html>not an image</html>')),null);
  assert.equal(photoContentType(Buffer.from([137,80,78,71,13,10,26,10])), 'image/png');
});

test('reminder handler uses bound origin and sender, not event-supplied URLs', async () => {
  const {reminderEmail}=await import('../lambda/booking-reminder.mjs');
  const event={bookingId:'fixture',token:'a'.repeat(32),recipient:'guest@example.invalid',title:'Planning call',startsAt:'2030-01-01T10:00:00Z',url:'https://attacker.invalid'};
  const env={DAYMARK_APP_URL:'https://app.example.invalid',NEANDER_EMAIL_FROM:'owned@apps.example.invalid',AWS_SES_CONFIGURATION_SET:'owned-config'};
  const result=reminderEmail(event,env);
  assert.equal(result.FromEmailAddress,env.NEANDER_EMAIL_FROM);assert.equal(result.ConfigurationSetName,env.AWS_SES_CONFIGURATION_SET);
  assert.ok(result.Content.Simple.Body.Text.Data.includes('https://app.example.invalid/booking/'+event.token));
  assert.ok(!result.Content.Simple.Body.Text.Data.includes('attacker.invalid'));
  assert.throws(()=>reminderEmail({...event,token:'../other-user'},env),/Invalid booking/);
});

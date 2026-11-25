// Fictional starter data. Never run against a live customer database.
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { hashPassword } from 'better-auth/crypto';
import { Client } from 'pg';

export const DEMO_HOST_ID = 'template-calendly-maya';
export const DEMO_EMAIL = 'maya.chen@example.invalid';
export function futureWeekday(days = 2, now = new Date()) {
  const value = new Date(now);
  value.setUTCDate(value.getUTCDate() + days);
  value.setUTCHours(10, 0, 0, 0);
  while ([0, 6].includes(value.getUTCDay())) value.setUTCDate(value.getUTCDate() + 1);
  return value;
}

export async function seed({ databaseUrl, password }) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (!password || password.length < 12) throw new Error('DEMO_HOST_PASSWORD must contain at least 12 characters');
  const client = new Client({ connectionString: databaseUrl, options: '-c timezone=UTC', connectionTimeoutMillis: 10000, statement_timeout: 30000 });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('template-calendly-seed-v1'))");
    if ((await client.query('SELECT id FROM "user" WHERE id=$1', [DEMO_HOST_ID])).rowCount) {
      // The first successful seed owns initialization. Never reset edited records,
      // passwords, dates or deleted children on a retry.
      await client.query('COMMIT');
      return { created: false };
    }
    const passwordHash = await hashPassword(password);
    await client.query('INSERT INTO "user" (id,name,email,email_verified,timezone,username) VALUES ($1,$2,$3,true,$4,$5)', [DEMO_HOST_ID, 'Maya Chen', DEMO_EMAIL, 'UTC', 'maya-chen']);
    await client.query('INSERT INTO account (id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES ($1,$2,$3,$2,$4,NOW(),NOW())', ['template-calendly-credential', DEMO_HOST_ID, 'credential', passwordHash]);
    await client.query('INSERT INTO event_type (id,user_id,name,description,duration_minutes,location,slug,is_default) VALUES ($1,$2,$3,$4,30,$5,$6,true)', ['template-calendly-event', DEMO_HOST_ID, 'Discovery call', 'A friendly introduction to your project and what we can build together.', 'Video call — details shared after booking', 'discovery-call']);
    await client.query('INSERT INTO booking_question (id,user_id,label,question_type,required,position) VALUES ($1,$2,$3,$4,false,0)', ['template-calendly-question', DEMO_HOST_ID, 'What would you like to discuss?', 'long_text']);
    for (let weekday = 1; weekday <= 5; weekday++) {
      await client.query('INSERT INTO availability_range (id,user_id,weekday,start_minute,end_minute) VALUES ($1,$2,$3,540,1020)', [`template-calendly-hours-${weekday}`, DEMO_HOST_ID, weekday]);
    }
    await client.query('INSERT INTO availability_rule (id,user_id,buffer_before_minutes,buffer_after_minutes,minimum_notice_hours,booking_horizon_days,start_time_increment_minutes) VALUES ($1,$2,15,15,2,60,30)', ['template-calendly-rules', DEMO_HOST_ID]);
    const people = [ ['Alex Rivera', 'alex.rivera@example.invalid'], ['Sam Taylor', 'sam.taylor@example.invalid'], ['Jordan Lee', 'jordan.lee@example.invalid'] ];
    const dates = [futureWeekday(2), futureWeekday(5), futureWeekday(-7)];
    for (const [index, [name, email]] of people.entries()) {
      await client.query('INSERT INTO contact (id,host_id,name,email) VALUES ($1,$2,$3,$4)', [`template-calendly-contact-${index}`, DEMO_HOST_ID, name, email]);
      // Explicit UTC strings avoid pg serializing Date in the operator's local
      // timezone before PostgreSQL stores it in a timestamp-without-time-zone.
      await client.query('INSERT INTO booking (id,host_id,event_type_id,invitee_name,invitee_email,invitee_timezone,start_utc,end_utc,confirmation_token) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [`template-calendly-booking-${index}`, DEMO_HOST_ID, 'template-calendly-event', name, email, 'UTC', dates[index].toISOString(), new Date(dates[index].getTime() + 30 * 60000).toISOString(), randomBytes(24).toString('hex')]);
    }
    await client.query('INSERT INTO booking_answer (id,booking_id,question_id,question_label,answer,position) VALUES ($1,$2,$3,$4,$5,0)', ['template-calendly-answer', 'template-calendly-booking-0', 'template-calendly-question', 'What would you like to discuss?', 'Planning a new website for our fictional design studio.']);
    await client.query('INSERT INTO poll (id,host_id,title,description,duration_minutes,token,show_votes) VALUES ($1,$2,$3,$4,45,$5,true)', ['template-calendly-poll', DEMO_HOST_ID, 'Studio planning session', 'Find a time for our next team conversation.', randomBytes(24).toString('hex')]);
    for (let index = 0; index < 2; index++) {
      await client.query('INSERT INTO poll_option (id,poll_id,start_utc) VALUES ($1,$2,$3)', [`template-calendly-poll-option-${index}`, 'template-calendly-poll', futureWeekday(8 + index * 2).toISOString()]);
    }
    await client.query('INSERT INTO poll_vote (id,poll_id,name,email) VALUES ($1,$2,$3,$4)', ['template-calendly-vote', 'template-calendly-poll', people[0][0], people[0][1]]);
    await client.query('INSERT INTO poll_vote_option (vote_id,option_id) VALUES ($1,$2)', ['template-calendly-vote', 'template-calendly-poll-option-0']);
    await client.query('INSERT INTO booking_link (id,host_id,token,kind,event_type_id) VALUES ($1,$2,$3,$4,$5)', ['template-calendly-link', DEMO_HOST_ID, randomBytes(24).toString('hex'), 'event_type', 'template-calendly-event']);
    await client.query('COMMIT');
    return { created: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await seed({ databaseUrl: process.env.DATABASE_URL, password: process.env.DEMO_HOST_PASSWORD });
  console.log(result.created ? 'Fictional scheduling workspace initialized.' : 'Scheduling workspace already initialized; existing data preserved.');
}

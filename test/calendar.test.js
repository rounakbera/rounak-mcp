import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { call, connect, link, OWNER, setup, signInAndGetTokens, WORK } from './helpers/harness.js';

const FAMILY = 'family@group.calendar.google.com';
const HIDDEN = 'hidden@group.calendar.google.com';
const RANGE = { time_min: '2026-10-21T00:00:00Z', time_max: '2026-10-24T00:00:00Z' };

// OWNER: primary + a shown family calendar + one hidden in Google Calendar. WORK: primary only.
function seed(google) {
  const cal = (id, extra) => ({ id, summary: id, selected: true, accessRole: 'owner', timeZone: 'America/Los_Angeles', ...extra });
  const ev = (id, summary, start, end, extra) => ({ id, summary, status: 'confirmed', start, end, ...extra });
  const owner = google.calendar(OWNER);
  owner.calendars.push(cal(OWNER, { primary: true }), cal(FAMILY, { summaryOverride: 'Family' }), cal(HIDDEN, { selected: false }));
  owner.events[OWNER] = [
    ev('dentist', 'Dentist', { dateTime: '2026-10-21T09:00:00-07:00' }, { dateTime: '2026-10-21T10:00:00-07:00' }, {
      organizer: { email: 'dentist@example.com' },
      attendees: [{ email: 'dentist@example.com', responseStatus: 'accepted' }, { email: OWNER, self: true, responseStatus: 'needsAction' }],
    }),
  ];
  owner.events[FAMILY] = [
    ev('soccer', 'Soccer', { dateTime: '2026-10-21T17:00:00Z' }, { dateTime: '2026-10-21T18:00:00Z' }),
    ev('trip', 'Trip', { date: '2026-10-22' }, { date: '2026-10-23' }),
  ];
  owner.events[HIDDEN] = [ev('hidden', 'Hidden thing', { dateTime: '2026-10-21T12:00:00Z' }, { dateTime: '2026-10-21T13:00:00Z' })];
  const work = google.calendar(WORK);
  work.calendars.push(cal(WORK, { primary: true, timeZone: 'Europe/London' }));
  work.events[WORK] = [ev('standup', 'Standup', { dateTime: '2026-10-21T16:30:00Z' }, { dateTime: '2026-10-21T16:45:00Z' })];
}

async function start(opts) {
  const ctx = await setup(opts);
  seed(ctx.google);
  await link(ctx, OWNER);
  await link(ctx, WORK);
  return { ctx, client: await connect(ctx, (await signInAndGetTokens(ctx)).access_token) };
}

describe('calendar', () => {
  let ctx, client;
  before(async () => ({ ctx, client } = await start()));
  after(() => ctx.teardown());

  test('lists calendars on every account, marking the defaults', async () => {
    const cals = await call(client, 'calendar_list_calendars');
    assert.deepEqual(cals.map((c) => [c.account, c.calendar_id, c.name, c.default]).sort(), [
      [OWNER, FAMILY, 'Family', true],
      [OWNER, HIDDEN, HIDDEN, false],
      [OWNER, OWNER, OWNER, true],
      [WORK, WORK, WORK, true],
    ]);
  });

  test('merges default calendars across accounts, sorted by start', async () => {
    const events = await call(client, 'calendar_list_events', RANGE);
    assert.deepEqual(events.map((e) => [e.event_id, e.account, e.calendar_id]), [
      ['dentist', OWNER, OWNER],
      ['standup', WORK, WORK],
      ['soccer', OWNER, FAMILY],
      ['trip', OWNER, FAMILY],
    ]);
    const trip = events.find((e) => e.event_id === 'trip');
    assert.deepEqual([trip.all_day, trip.start, trip.time_zone], [true, '2026-10-22', 'America/Los_Angeles']);
    assert.equal((await call(client, 'calendar_list_events', { ...RANGE, max_results: 2 })).length, 2);
  });

  test('filters by account and calendar ID; "primary" works on every account', async () => {
    const hidden = await call(client, 'calendar_list_events', { ...RANGE, calendar_ids: [HIDDEN] });
    assert.deepEqual(hidden.map((e) => e.event_id), ['hidden']);
    const primaries = await call(client, 'calendar_list_events', { ...RANGE, calendar_ids: ['primary'] });
    assert.deepEqual(primaries.map((e) => e.event_id), ['dentist', 'standup']);
    const work = await call(client, 'calendar_list_events', { ...RANGE, account: WORK });
    assert.deepEqual(work.map((e) => e.event_id), ['standup']);
    await assert.rejects(call(client, 'calendar_list_events', { ...RANGE, calendar_ids: ['nope@example.com'] }), /No linked account has calendar/);
  });

  test('rejects times without an offset', async () => {
    await assert.rejects(call(client, 'calendar_list_events', { time_min: '2026-10-21T09:00:00' }), /time_min/);
  });

  test('rejects IDs that would change the request path', async () => {
    for (const [calendar_id, event_id] of [['..', 'dentist'], ['primary', '..'], ['primary', '.'], ['primary', '']]) {
      await assert.rejects(call(client, 'calendar_delete_event', { account: OWNER, calendar_id, event_id }), /non-empty ID/);
    }
    await assert.rejects(call(client, 'calendar_list_events', { ...RANGE, calendar_ids: ['..'] }), /non-empty ID/);
    assert.equal(ctx.google.calendar(OWNER).writes.length, 0);
  });

  test('creating, changing and deleting events are marked destructive', async () => {
    const { tools } = await client.listTools();
    const destructive = tools.filter((t) => t.name.startsWith('calendar_') && t.annotations.destructiveHint).map((t) => t.name);
    assert.deepEqual(destructive.sort(), ['calendar_create_event', 'calendar_delete_event', 'calendar_update_event']);
  });

  test('errors instead of skipping an account with no default calendars', async () => {
    const [work] = ctx.google.calendar(WORK).calendars;
    work.selected = false;
    try {
      await assert.rejects(call(client, 'calendar_find_free_time', RANGE), /work@example\.com has no default calendars/);
      await assert.rejects(call(client, 'calendar_list_events', RANGE), /no default calendars/);
    } finally {
      work.selected = true;
    }
  });

  test('creates, updates and deletes events, only notifying attendees when asked', async () => {
    const created = await call(client, 'calendar_create_event', {
      account: OWNER,
      calendar_id: FAMILY,
      title: 'Dinner',
      start: '2026-10-23T19:00:00-07:00',
      end: '2026-10-23T21:00:00-07:00',
      time_zone: 'America/Los_Angeles',
      attendees: ['guest@example.com'],
      add_meet: true,
    });
    assert.equal(created.meet, 'https://meet.google.com/abc-defg-hij');
    const { writes, events } = ctx.google.calendar(OWNER);
    assert.deepEqual(writes[0].query, { sendUpdates: 'none', conferenceDataVersion: '1' });
    assert.deepEqual(writes[0].json.start, { dateTime: '2026-10-23T19:00:00-07:00', timeZone: 'America/Los_Angeles' });

    const id = created.event_id;
    const updated = await call(client, 'calendar_update_event', { account: OWNER, calendar_id: FAMILY, event_id: id, title: 'Late dinner', send_updates: 'all' });
    assert.equal(updated.title, 'Late dinner');
    assert.deepEqual(writes[1].json, { summary: 'Late dinner' });
    assert.equal(writes[1].query.sendUpdates, 'all');
    assert.equal((await call(client, 'calendar_get_event', { account: OWNER, calendar_id: FAMILY, event_id: id })).start, '2026-10-23T19:00:00-07:00');

    await call(client, 'calendar_delete_event', { account: OWNER, calendar_id: FAMILY, event_id: id });
    assert.ok(!events[FAMILY].some((e) => e.id === id));
  });

  test('creates all-day events', async () => {
    const e = await call(client, 'calendar_create_event', { account: WORK, title: 'Offsite', start: '2026-11-02', end: '2026-11-04' });
    assert.deepEqual([e.all_day, e.calendar_id], [true, 'primary']);
    assert.deepEqual(ctx.google.calendar(WORK).writes[0].json.end, { date: '2026-11-04' });
  });

  test('responds to an invitation, sending only our own response', async () => {
    const e = await call(client, 'calendar_respond_to_event', { account: OWNER, event_id: 'dentist', response: 'accepted' });
    assert.deepEqual(e.attendees, [
      { email: 'dentist@example.com', response: 'accepted' },
      { email: OWNER, response: 'accepted', self: true },
    ]);
    assert.deepEqual(ctx.google.calendar(OWNER).writes.at(-1).json, { attendeesOmitted: true, attendees: [{ email: OWNER, responseStatus: 'accepted' }] });
    await assert.rejects(call(client, 'calendar_respond_to_event', { account: OWNER, calendar_id: FAMILY, event_id: 'soccer', response: 'declined' }), /not an attendee/);
  });

  test('finds free time across accounts', async () => {
    const { free, busy } = await call(client, 'calendar_find_free_time', {
      time_min: '2026-10-21T15:00:00Z',
      time_max: '2026-10-21T19:00:00Z',
      duration_minutes: 30,
    });
    // Dentist 16:00-17:00 and standup 16:30-16:45 merge; soccer follows at 17:00.
    assert.deepEqual(busy, [{ start: '2026-10-21T16:00:00.000Z', end: '2026-10-21T18:00:00.000Z' }]);
    assert.deepEqual(free, [
      { start: '2026-10-21T15:00:00.000Z', end: '2026-10-21T16:00:00.000Z' },
      { start: '2026-10-21T18:00:00.000Z', end: '2026-10-21T19:00:00.000Z' },
    ]);
  });
});

describe('calendar with CALENDAR_IDS', () => {
  let ctx, client;
  before(async () => ({ ctx, client } = await start({ calendarIds: ['primary', HIDDEN] })));
  after(() => ctx.teardown());

  test('reads only the configured calendars by default', async () => {
    const events = await call(client, 'calendar_list_events', RANGE);
    assert.deepEqual(events.map((e) => e.event_id), ['hidden', 'dentist', 'standup']);
    const defaults = (await call(client, 'calendar_list_calendars')).filter((c) => c.default).map((c) => c.calendar_id);
    assert.deepEqual(defaults.sort(), [HIDDEN, OWNER, WORK].sort());
  });
});

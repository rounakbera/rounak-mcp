import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { account, DESTRUCTIVE, id, READ } from '../../tools.js';

const MAX_DESCRIPTION_CHARS = 5_000;
const DAY = 86_400_000;

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);
const time = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
const eventTime = time.describe('ISO 8601 date-time with offset (e.g. 2026-10-21T09:00:00-07:00), or YYYY-MM-DD for all-day');
const calendarId = id.default('primary').describe('Calendar ID from calendar_list_calendars; "primary" is the account\'s main calendar');
const calendarIds = z.array(id).optional().describe('Calendar IDs to use ("primary" allowed); defaults to the default calendars of each account');
const timeZone = z.string().optional().describe('IANA time zone, e.g. "America/Los_Angeles"');
const sendUpdates = z.enum(['all', 'externalOnly', 'none']).default('none').describe('"all" emails invitations or updates to attendees');
const eventFields = {
  title: z.string(),
  start: eventTime,
  end: eventTime.describe('Exclusive end; for all-day events the day after the last day'),
  time_zone: timeZone.describe('Time zone for start/end; defaults to the calendar\'s'),
  description: z.string().optional(),
  location: z.string().optional(),
  attendees: z.array(z.email()).optional(),
};

const when = (v, tz) => (isDate(v) ? { date: v } : { dateTime: v, ...(tz && { timeZone: tz }) });
const startMs = (e) => Date.parse(e.start);

// Compact event for Claude, tagged with where it lives.
function event(acct, calId, e, calendarTz) {
  return {
    account: acct,
    calendar_id: calId,
    event_id: e.id,
    title: e.summary,
    start: e.start?.dateTime ?? e.start?.date,
    end: e.end?.dateTime ?? e.end?.date,
    all_day: Boolean(e.start?.date),
    time_zone: e.start?.timeZone ?? calendarTz,
    location: e.location,
    description: e.description?.slice(0, MAX_DESCRIPTION_CHARS),
    status: e.status,
    organizer: e.organizer?.email,
    attendees: e.attendees?.map((a) => ({ email: a.email, response: a.responseStatus, ...(a.self && { self: true }) })),
    meet: e.hangoutLink,
    recurring_event_id: e.recurringEventId,
    link: e.htmlLink,
  };
}

export default {
  scopes: [
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.freebusy',
  ],

  register({ google, linked, resolve, tool, config }) {
    const api = (email, method, path, body) => google.request(email, method, `${google.endpoints.calendar}${path}`, body);
    const cal = (args, method, path, body) => api(resolve(args.account), method, path, body);
    const eventPath = (calId, eventId = '') => `/calendars/${encodeURIComponent(calId)}/events${eventId && `/${encodeURIComponent(eventId)}`}`;
    const accounts = (email) => (email ? [resolve(email)] : linked());

    // CALENDAR_IDS picks the default calendars; otherwise the ones shown in Google Calendar.
    const isDefault = (c) => (config.calendarIds ? matches(c, config.calendarIds) : c.selected && !c.hidden);
    const matches = (c, ids) => ids.includes(c.id) || (c.primary && ids.includes('primary'));

    async function calendars(acct) {
      const { items = [] } = await api(acct, 'GET', '/users/me/calendarList?maxResults=250');
      return items;
    }

    // The calendars to read on each account: `ids` where the account has them, else its defaults.
    // An account with no default calendars is an error, so its events are never silently missing.
    async function pick(accts, ids) {
      const picked = await Promise.all(
        accts.map(async (acct) => {
          const cals = (await calendars(acct)).filter((c) => (ids ? matches(c, ids) : isDefault(c)));
          if (!ids && !cals.length) throw new Error(`${acct} has no default calendars; check CALENDAR_IDS or pass calendar_ids`);
          return cals.map((c) => ({ acct, c }));
        }),
      );
      if (ids && !picked.flat().length) throw new Error(`No linked account has calendar ${ids.join(', ')}`);
      return picked.flat();
    }

    const writeQuery = (args, extra = {}) => `?${new URLSearchParams({ sendUpdates: args.send_updates, ...extra })}`;
    function eventBody(args) {
      return Object.fromEntries(
        Object.entries({
          summary: args.title,
          start: args.start && when(args.start, args.time_zone),
          end: args.end && when(args.end, args.time_zone),
          description: args.description,
          location: args.location,
          attendees: args.attendees?.map((email) => ({ email })),
        }).filter(([, v]) => v !== undefined),
      );
    }

    tool(
      'calendar_list_calendars',
      'List calendars and their IDs. Covers every linked account unless `account` is given; `default` marks the ones read when no calendar is named.',
      { account },
      READ,
      async (args) => {
        const results = await Promise.all(
          accounts(args.account).map(async (acct) =>
            (await calendars(acct)).map((c) => ({
              account: acct,
              calendar_id: c.id,
              name: c.summaryOverride ?? c.summary,
              primary: Boolean(c.primary),
              default: Boolean(isDefault(c)),
              access_role: c.accessRole,
              time_zone: c.timeZone,
            })),
          ),
        );
        return results.flat();
      },
    );

    tool(
      'calendar_list_events',
      'List events in a time range, merged across calendars and sorted by start. Reads the default calendars of every linked account unless `account` or `calendar_ids` is given. Recurring events are expanded into occurrences.',
      {
        time_min: z.iso.datetime({ offset: true }).optional().describe('Range start (ISO 8601 with offset); defaults to now'),
        time_max: z.iso.datetime({ offset: true }).optional().describe('Range end; defaults to 7 days after time_min'),
        account,
        calendar_ids: calendarIds,
        query: z.string().optional().describe('Free-text search in titles, descriptions, locations and attendees'),
        time_zone: timeZone.describe('Time zone to express event times in; defaults to each calendar\'s'),
        max_results: z.number().int().min(1).max(250).default(50).describe('Total, across all calendars'),
      },
      READ,
      async (args) => {
        const timeMin = args.time_min ?? new Date().toISOString();
        const timeMax = args.time_max ?? new Date(Date.parse(timeMin) + 7 * DAY).toISOString();
        const q = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: args.max_results });
        if (args.query) q.set('q', args.query);
        if (args.time_zone) q.set('timeZone', args.time_zone);
        const results = await Promise.all(
          (await pick(accounts(args.account), args.calendar_ids)).map(async ({ acct, c }) => {
            const { items = [], timeZone: tz } = await api(acct, 'GET', `${eventPath(c.id)}?${q}`);
            return items.map((e) => event(acct, c.id, e, tz));
          }),
        );
        return results.flat().sort((a, b) => startMs(a) - startMs(b)).slice(0, args.max_results);
      },
    );

    tool('calendar_get_event', 'Read one calendar event', { event_id: id, calendar_id: calendarId, account }, READ, async (args) =>
      event(resolve(args.account), args.calendar_id, await cal(args, 'GET', eventPath(args.calendar_id, args.event_id))),
    );

    tool(
      'calendar_create_event',
      'Create a calendar event. Attendees can see its details even when send_updates is "none"; send_updates only controls whether they are emailed.',
      { account, calendar_id: calendarId, ...eventFields, add_meet: z.boolean().default(false).describe('Attach a Google Meet link'), send_updates: sendUpdates },
      // Destructive because inviting attendees shares the event's contents outside the account.
      DESTRUCTIVE,
      async (args) => {
        const body = eventBody(args);
        if (args.add_meet) body.conferenceData = { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
        const e = await cal(args, 'POST', `${eventPath(args.calendar_id)}${writeQuery(args, { conferenceDataVersion: 1 })}`, body);
        return event(resolve(args.account), args.calendar_id, e);
      },
    );

    tool(
      'calendar_update_event',
      'Change fields of a calendar event; omitted fields are left as they are. `attendees` replaces the whole guest list, and new attendees can see the event\'s details even when send_updates is "none".',
      {
        event_id: id,
        calendar_id: calendarId,
        account,
        ...Object.fromEntries(Object.entries(eventFields).map(([k, v]) => [k, v.optional()])),
        send_updates: sendUpdates,
      },
      DESTRUCTIVE,
      async (args) => {
        const e = await cal(args, 'PATCH', `${eventPath(args.calendar_id, args.event_id)}${writeQuery(args)}`, eventBody(args));
        return event(resolve(args.account), args.calendar_id, e);
      },
    );

    tool(
      'calendar_delete_event',
      'Delete a calendar event',
      { event_id: id, calendar_id: calendarId, account, send_updates: sendUpdates },
      DESTRUCTIVE,
      async (args) => {
        await cal(args, 'DELETE', `${eventPath(args.calendar_id, args.event_id)}${writeQuery(args)}`);
        return { ok: true };
      },
    );

    tool(
      'calendar_respond_to_event',
      'Accept, decline or tentatively accept an event you were invited to. The organizer sees the response.',
      { event_id: id, calendar_id: calendarId, account, response: z.enum(['accepted', 'declined', 'tentative']) },
      // Destructive because the response leaves the account: the organizer can be anyone.
      DESTRUCTIVE,
      async (args) => {
        const path = eventPath(args.calendar_id, args.event_id);
        const { attendees = [] } = await cal(args, 'GET', path);
        const self = attendees.find((a) => a.self);
        if (!self) throw new Error('You are not an attendee of this event');
        // attendeesOmitted: change only our own response and leave the rest of the guest list alone.
        const e = await cal(args, 'PATCH', path, { attendeesOmitted: true, attendees: [{ email: self.email, responseStatus: args.response }] });
        return event(resolve(args.account), args.calendar_id, e);
      },
    );

    tool(
      'calendar_find_free_time',
      'Find free slots in a time range, treating every default calendar of every linked account as busy time unless `account` or `calendar_ids` is given',
      {
        time_min: z.iso.datetime({ offset: true }),
        time_max: z.iso.datetime({ offset: true }),
        duration_minutes: z.number().int().min(5).max(24 * 60).default(30).describe('Shortest free slot to return'),
        account,
        calendar_ids: calendarIds,
      },
      READ,
      async (args) => {
        const byAccount = Object.groupBy(await pick(accounts(args.account), args.calendar_ids), ({ acct }) => acct);
        const errors = [];
        const busy = (
          await Promise.all(
            Object.entries(byAccount).map(async ([acct, cals]) => {
              const body = { timeMin: args.time_min, timeMax: args.time_max, items: cals.map(({ c }) => ({ id: c.id })) };
              const { calendars: res = {} } = await api(acct, 'POST', '/freeBusy', body);
              return Object.entries(res).flatMap(([calId, r]) => {
                if (r.errors?.length) errors.push({ account: acct, calendar_id: calId, reason: r.errors[0].reason });
                return (r.busy ?? []).map((b) => [Date.parse(b.start), Date.parse(b.end)]);
              });
            }),
          )
        ).flat();

        // Merge overlapping busy blocks, then return the gaps that are long enough.
        busy.sort((a, b) => a[0] - b[0]);
        const merged = [];
        for (const [s, e] of busy) {
          if (merged.length && s <= merged.at(-1)[1]) merged.at(-1)[1] = Math.max(merged.at(-1)[1], e);
          else merged.push([s, e]);
        }
        const free = [];
        let cursor = Date.parse(args.time_min);
        for (const [s, e] of [...merged, [Date.parse(args.time_max), Infinity]]) {
          if (s - cursor >= args.duration_minutes * 60_000) free.push([cursor, s]);
          cursor = Math.max(cursor, e);
        }
        const iso = ([s, e]) => ({ start: new Date(s).toISOString(), end: new Date(e).toISOString() });
        return { free: free.map(iso), busy: merged.map(iso), ...(errors.length && { errors }) };
      },
    );
  },
};

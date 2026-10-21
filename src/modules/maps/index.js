import { z } from 'zod';
import { READ } from '../../tools.js';

// Saved Google Maps lists, read through their share links. Google has no API for these, so this
// calls the unauthenticated endpoint the shared-list page uses. Its format is undocumented and may
// change; parsing fails loudly rather than returning partial data.
const MAX_PLACES = 2_000;
const MAX_RESPONSE_BYTES = 10_000_000;
const TIMEOUT_MS = 10_000;
const CACHE_MS = 5 * 60_000;
const cache = new Map(); // url -> { at, list }

// Google sends CIDs as signed 64-bit integers; Maps links want them unsigned.
const mapsUrl = (cid) => /^-?\d+$/.test(cid ?? '') && `https://www.google.com/maps?cid=${BigInt.asUintN(64, BigInt(cid))}`;

function km(a, b) {
  const rad = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lng - a.lng) * rad) / 2) ** 2;
  return 12_742 * Math.asin(Math.sqrt(h));
}

async function readCapped(res) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    if ((size += chunk.length) > MAX_RESPONSE_BYTES) throw new Error('response too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

// Keeps only the list's name and places. The response also names the list's owner, which is dropped.
// JSON.parse errors quote the body, so they're replaced rather than passed on.
function parse(id, text) {
  let list;
  try {
    [list] = JSON.parse(text.replace(/^\)\]\}'\n/, ''));
  } catch {
    throw new Error('unexpected response format');
  }
  const items = list?.[8] ?? [];
  if (typeof list?.[4] !== 'string' || !Array.isArray(items)) throw new Error('unexpected response format');
  const places = items.map((p) => {
    const [, , , , address, coords, ids] = p?.[1] ?? [];
    if (typeof p[2] !== 'string' || typeof coords?.[2] !== 'number' || typeof coords?.[3] !== 'number') throw new Error('unexpected place format');
    return { name: p[2], note: p[3] || undefined, address: address || undefined, lat: coords[2], lng: coords[3], maps_url: mapsUrl(ids?.[1]) || undefined };
  });
  return { id, name: list[4], places };
}

export default {
  scopes: [],

  register({ google, tool, config }) {
    const url = (id) => `${google.endpoints.maps}?authuser=0&hl=en&gl=us&pb=!1m4!1s${encodeURIComponent(id)}!2e1!3m1!1e1!2e2!3e2!4i${MAX_PLACES}!16b1`;

    async function load(id) {
      const hit = cache.get(url(id));
      if (hit && Date.now() - hit.at < CACHE_MS) return hit.list;
      try {
        const res = await fetch(url(id), { redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!res.ok) throw new Error(`HTTP ${res.status}; check the list is still shared`);
        const list = parse(id, await readCapped(res));
        cache.set(url(id), { at: Date.now(), list });
        return list;
      } catch (e) {
        throw new Error(`Couldn't read Google Maps list ${id}: ${e.message}`);
      }
    }

    // `filter` holds list IDs or names. Only IDs can be matched without fetching every list.
    async function pick(filter) {
      const all = config.mapsListIds;
      const lists = await Promise.all((filter?.every((f) => all.includes(f)) ? filter : all).map(load));
      if (!filter) return lists;
      const matches = (l, f) => f === l.id || f.toLowerCase() === l.name.toLowerCase();
      const unknown = filter.filter((f) => !lists.some((l) => matches(l, f)));
      if (unknown.length) throw new Error(`Unknown list ${unknown.join(', ')}. Lists: ${lists.map((l) => l.name).join(', ')}`);
      return lists.filter((l) => filter.some((f) => matches(l, f)));
    }

    tool('maps_list_saved_lists', 'List my saved Google Maps lists, with their IDs and number of places', {}, READ, async () =>
      (await pick()).map((l) => ({ list_id: l.id, name: l.name, places: l.places.length })),
    );

    tool(
      'maps_search_saved',
      'Search places saved in my Google Maps lists, by text and/or distance from a point. Without `near`, results are newest first within each list. Many places have no address, so search by location with `near` rather than by address text.',
      {
        lists: z.array(z.string()).optional().describe('List names or IDs to search; defaults to all'),
        query: z.string().optional().describe('Case-insensitive text to find in place names, addresses and notes'),
        near: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).optional().describe('Sort by distance from this point; approximate coordinates (e.g. of a neighbourhood) are fine'),
        radius_km: z.number().positive().max(20_000).optional().describe('Only places within this distance of `near`'),
        max_results: z.number().int().min(1).max(500).default(50),
      },
      READ,
      async (args) => {
        if (args.radius_km && !args.near) throw new Error('radius_km needs `near`');
        const q = args.query?.toLowerCase();
        let places = (await pick(args.lists))
          .flatMap((l) => l.places.map((p) => ({ ...p, list: l.name })))
          .filter((p) => !q || [p.name, p.address, p.note].some((s) => s?.toLowerCase().includes(q)));
        if (args.near) {
          places = places
            .map((p) => ({ ...p, distance_km: km(args.near, p) }))
            .filter((p) => !args.radius_km || p.distance_km <= args.radius_km)
            .sort((a, b) => a.distance_km - b.distance_km);
        }
        // Rounded to 10 m only for output, so nearby places still read as different distances.
        const round = (p) => (p.distance_km === undefined ? p : { ...p, distance_km: Math.round(p.distance_km * 100) / 100 });
        return { total_matches: places.length, places: places.slice(0, args.max_results).map(round) };
      },
    );
  },
};

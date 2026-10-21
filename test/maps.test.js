import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { mapsList } from './helpers/fake-google.js';
import { call, connect, setup, signInAndGetTokens } from './helpers/harness.js';

const SOHO = { lat: 40.7233, lng: -74.003 };

describe('maps', () => {
  let ctx, client;
  before(async () => {
    ctx = await setup({ mapsListIds: ['nyc-list', 'dessert-list'] });
    ctx.google.state.mapsLists.set('nyc-list', mapsList('nyc-list', 'NYC', [
      { name: 'Fish Place', address: '1 Example St, New York, NY 10013', lat: 40.7184, lng: -73.996, cid: '1234567890123456789' },
      { name: 'Pasta Place', note: 'great pasta', lat: 40.7177, lng: -73.9451, cid: '-1000000000000000000' },
      { name: 'Uptown Diner', lat: 40.787, lng: -73.975, cid: '42' },
    ]));
    ctx.google.state.mapsLists.set('dessert-list', mapsList('dessert-list', 'dessert', [
      { name: 'Gelato Spot', lat: 40.7241, lng: -74.0018, cid: '7' },
    ]));
    client = await connect(ctx, (await signInAndGetTokens(ctx)).access_token);
  });
  after(() => ctx.teardown());

  test('lists saved lists without linking a Google account', async () => {
    assert.deepEqual(await call(client, 'maps_list_saved_lists'), [
      { list_id: 'nyc-list', name: 'NYC', places: 3 },
      { list_id: 'dessert-list', name: 'dessert', places: 1 },
    ]);
  });

  test('sorts by distance across lists and filters by radius', async () => {
    const { total_matches, places } = await call(client, 'maps_search_saved', { near: SOHO, radius_km: 5 });
    assert.equal(total_matches, 3);
    assert.deepEqual(places.map((p) => [p.name, p.list]), [['Gelato Spot', 'dessert'], ['Fish Place', 'NYC'], ['Pasta Place', 'NYC']]);
    assert.ok(places[0].distance_km < places[1].distance_km);
    const limited = await call(client, 'maps_search_saved', { near: SOHO, max_results: 1 });
    assert.deepEqual([limited.total_matches, limited.places.length], [4, 1]);
  });

  test('searches names, addresses and notes, and filters by list name or ID', async () => {
    const byNote = await call(client, 'maps_search_saved', { query: 'PASTA' });
    assert.deepEqual(byNote.places.map((p) => [p.name, p.note]), [['Pasta Place', 'great pasta']]);
    const byAddress = await call(client, 'maps_search_saved', { query: 'example st' });
    assert.deepEqual(byAddress.places.map((p) => p.name), ['Fish Place']);
    for (const lists of [['Dessert'], ['dessert-list']]) {
      assert.deepEqual((await call(client, 'maps_search_saved', { lists })).places.map((p) => p.name), ['Gelato Spot']);
    }
    await assert.rejects(call(client, 'maps_search_saved', { lists: ['bars'] }), /Unknown list bars\. Lists: NYC, dessert/);
    await assert.rejects(call(client, 'maps_search_saved', { radius_km: 1 }), /radius_km needs `near`/);
  });

  test('links places by unsigned CID and leaves out the list owner', async () => {
    const { places } = await call(client, 'maps_search_saved', { lists: ['NYC'] });
    assert.deepEqual(places.map((p) => p.maps_url), [
      'https://www.google.com/maps?cid=1234567890123456789',
      'https://www.google.com/maps?cid=17446744073709551616',
      'https://www.google.com/maps?cid=42',
    ]);
    const text = JSON.stringify(places);
    assert.ok(!text.includes('List Owner') && !text.includes('100000000000000000001'));
  });

  test('every maps tool is read-only', async () => {
    const { tools } = await client.listTools();
    assert.ok(tools.filter((t) => t.name.startsWith('maps_')).every((t) => t.annotations.readOnlyHint));
  });
});

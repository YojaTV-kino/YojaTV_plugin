import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createKino } from '../sdk/kino-shim.mjs';

const manifest = JSON.parse(readFileSync('./kino-plugin.json', 'utf8'));
const tape = JSON.parse(readFileSync('./test/fixtures.json', 'utf8'));

const { kino } = createKino(manifest, { tape });
globalThis.kino = kino;

const plugin = await import('../plugin.js');

test('home returns expected structure', async () => {
  const rows = await plugin.home();
  assert.ok(Array.isArray(rows), 'home should return an array');
  assert.ok(rows.length > 0, 'home should return at least 1 row');
  assert.ok(rows[0].id, 'row must have an id');
  assert.ok(rows[0].title, 'row must have a title');
});

test('episodes returns episode list for valid slug', async () => {
  const result = await plugin.episodes({ ref: 'one-piece' });
  assert.ok(result && Array.isArray(result.episodes), 'episodes must return object with episodes array');
  assert.ok(result.episodes.length > 0, 'should have episodes');
  assert.equal(result.episodes[0].number, 1);
});

test('resolve returns video url', async () => {
  const stream = await plugin.resolve({ ref: 'one-piece/1' });
  assert.ok(stream && stream.url, 'resolve must return object with url');
  assert.ok(stream.url.startsWith('http'), 'url must start with http');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { fixedWindowLimit } from './rate-limit.mjs';

test('separate callers, exact budget, and window rollover', async () => {
  let now = 1000;
  const limiter = fixedWindowLimit(2, { now: () => now });
  assert.equal((await limiter.limit({ key: 'a' })).success, true);
  assert.equal((await limiter.limit({ key: 'a' })).success, true);
  assert.equal((await limiter.limit({ key: 'a' })).success, false);
  assert.equal((await limiter.limit({ key: 'b' })).success, true);
  now = 60000;
  assert.equal((await limiter.limit({ key: 'a' })).success, true);
});

test('concurrent requests cannot overrun the budget', async () => {
  const limiter = fixedWindowLimit(60, { now: () => 1000 });
  const replies = await Promise.all(Array.from({ length: 200 }, () => limiter.limit({ key: 'a' })));
  assert.equal(replies.filter(x => x.success).length, 60);
});

test('key flood fails closed without evicting active counters', async () => {
  let now = 1000;
  const limiter = fixedWindowLimit(1, { now: () => now, maxKeys: 2 });
  assert.equal((await limiter.limit({ key: 'a' })).success, true);
  assert.equal((await limiter.limit({ key: 'b' })).success, true);
  assert.equal((await limiter.limit({ key: 'c' })).success, false);
  assert.equal((await limiter.limit({ key: 'a' })).success, false);
  now = 60000;
  assert.equal((await limiter.limit({ key: 'c' })).success, true);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { googleLoginProfile } from '../../packages/fleet-worker/src/google-oauth.mjs';

test('relay exchanges only through the configured HTTPS endpoint and returns verified identity', async () => {
  const env = { GOOGLE_RELAY_URL: 'https://relay.example/google', GOOGLE_RELAY_SECRET: 'test-only' };
  const profile = await googleLoginProfile(env, 'code', 'https://hub.example/callback', async (url, init) => {
    assert.equal(url, env.GOOGLE_RELAY_URL);
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.authorization, 'Bearer test-only');
    assert.deepEqual(JSON.parse(init.body), { code: 'code', redirect_uri: 'https://hub.example/callback' });
    return Response.json({ email: 'owner@example.test', verified_email: true, access_token: 'never-forward' });
  });
  assert.deepEqual(profile, { email: 'owner@example.test', verified_email: true });
});

test('relay rejects redirects, unverified identities and insecure configuration', async () => {
  const env = { GOOGLE_RELAY_URL: 'https://relay.example/google', GOOGLE_RELAY_SECRET: 'test-only' };
  for (const reply of [new Response(null, { status: 302 }), Response.json({ email: 'owner@example.test', verified_email: false })]) {
    await assert.rejects(googleLoginProfile(env, 'code', 'https://hub.example/callback', async () => reply));
  }
  let called = false;
  await assert.rejects(googleLoginProfile({ ...env, GOOGLE_RELAY_URL: 'http://relay.example/' }, 'code', 'https://hub.example/callback', async () => { called = true; }));
  assert.equal(called, false);
});

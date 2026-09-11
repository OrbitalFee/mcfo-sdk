// T29 — McfoClient: fee maths, headers, and error mapping against a mocked API.
import assert from "node:assert/strict";
import { test } from "node:test";

import { McfoClient, McfoError, gweiToWei } from "../dist/index.js";

const QUOTE = {
  fast: { fee: 21.0, unit: "gwei", confidence: 0.95, blocks: 1 },
  normal: { fee: 20.5, unit: "gwei", confidence: 0.85, blocks: 1 },
  slow: { fee: 20.1, unit: "gwei", confidence: 0.6, blocks: 3 },
  base_fee_gwei: 20.0,
  gas_used_ratio_mean: 0.5,
  gas_used_ratio_std: 0.05,
  source: "live",
  snapshotAge: 4,
};

const ADVANCED = {
  fee: 21.7,
  unit: "gwei",
  confidenceRequested: 0.9,
  confidenceAchieved: 0.92,
  blocks: 3,
  estSeconds: 36,
  base_fee_gwei: 20.9,
  source: "live",
  snapshotAge: 4,
};

/** Minimal Response stand-in; `calls` records every request for assertions. */
function mockFetch(handler, calls = []) {
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    const { status = 200, body = {}, headers = {} } = handler(url, init) ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k) => headers[k.toLowerCase()] ?? null },
      json: async () => body,
    };
  };
  fn.calls = calls;
  return fn;
}

function clientWith(handler, options = {}) {
  const fetchImpl = mockFetch(handler);
  return {
    client: new McfoClient({ baseUrl: "https://api.test", fetch: fetchImpl, ...options }),
    calls: fetchImpl.calls,
  };
}

test("gweiToWei survives fractional gwei", () => {
  assert.equal(gweiToWei(1), 1_000_000_000n);
  assert.equal(gweiToWei(0.1), 100_000_000n);
  assert.equal(gweiToWei(20.55), 20_550_000_000n);
});

test("getFeeParams(profile) derives tip and headroom from /v1/quick", async () => {
  const { client, calls } = clientWith(() => ({ body: QUOTE }));
  const params = await client.getFeeParams({ profile: "saver" });

  // saver -> slow tier: tip = 20.1 - 20.0 = 0.1 gwei
  assert.equal(params.maxPriorityFeePerGas, gweiToWei(0.1));
  // maxFee = base*2 + tip = 40.1 gwei
  assert.equal(params.maxFeePerGas, gweiToWei(40.1));
  assert.equal(params.source.endpoint, "/v1/quick");
  assert.equal(params.source.profile, "saver");
  assert.match(calls[0].url, /\/v1\/quick\?chain=eth$/);
});

test("profiles map onto the documented tiers and default to balanced", async () => {
  const mk = () => clientWith(() => ({ body: QUOTE })).client;
  assert.equal((await mk().getFeeParams({ profile: "priority" })).maxPriorityFeePerGas, gweiToWei(1.0));
  assert.equal((await mk().getFeeParams({ profile: "balanced" })).maxPriorityFeePerGas, gweiToWei(0.5));
  assert.equal((await mk().getFeeParams()).source.profile, "balanced");
});

test("baseFeeMultiplier is configurable", async () => {
  const { client } = clientWith(() => ({ body: QUOTE }));
  const params = await client.getFeeParams({ profile: "balanced", baseFeeMultiplier: 1 });
  assert.equal(params.maxFeePerGas, gweiToWei(20.5)); // base*1 + 0.5 tip
});

test("confidence/blocks route to /v1/advanced instead", async () => {
  const { client, calls } = clientWith(() => ({ body: ADVANCED }));
  const params = await client.getFeeParams({ confidence: 0.95, blocks: 2 });

  assert.match(calls[0].url, /\/v1\/advanced\?/);
  assert.match(calls[0].url, /confidence=0\.95/);
  assert.match(calls[0].url, /blocks=2/);
  assert.equal(params.source.endpoint, "/v1/advanced");
  // tip = 21.7 - 20.9 = 0.8 gwei (float noise rounded away by gweiToWei)
  assert.equal(params.maxPriorityFeePerGas, gweiToWei(0.8));
});

test("apiKey is sent as X-API-Key, omitted when anonymous", async () => {
  const withKey = clientWith(() => ({ body: QUOTE }), { apiKey: "mcfo_deadbeef" });
  await withKey.client.getQuote();
  assert.equal(withKey.calls[0].init.headers["X-API-Key"], "mcfo_deadbeef");

  const anon = clientWith(() => ({ body: QUOTE }));
  await anon.client.getQuote();
  assert.equal("X-API-Key" in anon.calls[0].init.headers, false);
});

test("getAdvice POSTs the documented body with defaults", async () => {
  const { client, calls } = clientWith(() => ({
    body: { waitMinutes: 10, savePercent: 14.6, estFutureMaxFee: 15.5, confidence: 0.49 },
  }));
  const advice = await client.getAdvice({ targetSavingPct: 20 });

  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    chain: "eth",
    gasLimit: 21000,
    targetSavingPct: 20,
  });
  assert.equal(advice.waitMinutes, 10);
});

test("503 maps to feed_stale with retryAfterSeconds", async () => {
  const { client } = clientWith(() => ({
    status: 503,
    body: { error: "feed_stale", retryAfterSeconds: 15 },
  }));
  const err = await client.getQuote().then(() => null, (e) => e);
  assert.ok(err instanceof McfoError);
  assert.equal(err.code, "feed_stale");
  assert.equal(err.retryAfterSeconds, 15);
});

test("429 maps to rate_limited and prefers the Retry-After header", async () => {
  const { client } = clientWith(() => ({
    status: 429,
    body: { error: "rate_limited" },
    headers: { "retry-after": "42" },
  }));
  const err = await client.getQuote().then(() => null, (e) => e);
  assert.equal(err.code, "rate_limited");
  assert.equal(err.retryAfterSeconds, 42);
});

test("401 and 422 map to their typed errors", async () => {
  const unauth = clientWith(() => ({ status: 401, body: { error: "invalid_api_key" } }));
  assert.equal((await unauth.client.getQuote().catch((e) => e)).code, "invalid_api_key");

  const bad = clientWith(() => ({ status: 422, body: { error: "invalid_param", param: "blocks" } }));
  const err = await bad.client.getAdvanced({ blocks: 99 }).catch((e) => e);
  assert.equal(err.code, "invalid_param");
  assert.equal(err.param, "blocks");
});

test("transport failures surface as network_error, not an unhandled rejection", async () => {
  const client = new McfoClient({
    baseUrl: "https://api.test",
    fetch: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  const err = await client.getQuote().catch((e) => e);
  assert.equal(err.code, "network_error");
});

// Contract tests: responses recorded from the live API (mcfo.zgos.eu,
// 2026-10-12 09:49 UTC) replayed through McfoClient. If the API's shape drifts
// from what the SDK reads, these fail; every derived wei value is checked
// exactly, by hand, from the recorded numbers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { McfoClient, McfoError, feeParamsFromQuote } from "../dist/index.js";

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

const QUICK = fixture("quick");
const ADVANCED = fixture("advanced");
const ADVICE = fixture("advice");
const E422 = fixture("error-422-invalid-param");
const E503 = fixture("error-503-feed-stale");

/** Serves one recorded response per path, as the real API answered it. */
function replay(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const { status = 200, body, headers = {}, text } = routes[path] ?? { status: 404, body: {} };
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k) => headers[k.toLowerCase()] ?? null },
      json: async () => (text !== undefined ? JSON.parse(text) : body),
    };
  };
  return { client: new McfoClient({ baseUrl: "https://api.test", fetch: fetchImpl }), calls };
}

test("real /v1/quick: every field the SDK declares is present and typed", async () => {
  const { client } = replay({ "/v1/quick": { body: QUICK } });
  const q = await client.getQuote();
  for (const tier of ["slow", "normal", "fast"]) {
    assert.equal(typeof q[tier].fee, "number", `${tier}.fee`);
    assert.equal(q[tier].unit, "gwei");
    assert.equal(typeof q[tier].confidence, "number");
    assert.equal(typeof q[tier].blocks, "number");
    assert.equal(typeof q[tier].savingPct, "number", `${tier}.savingPct`);
  }
  assert.equal(typeof q.base_fee_gwei, "number");
  assert.equal(typeof q.snapshotAge, "number");
  assert.equal(typeof q.naiveFee, "number");
  assert.equal(typeof q.savingBasis, "string");
  assert.equal(typeof q.quoteBasis, "string");
});

test("real /v1/quick: tiers are ordered slow <= normal <= fast and above the base fee", async () => {
  const { client } = replay({ "/v1/quick": { body: QUICK } });
  const q = await client.getQuote();
  assert.ok(q.slow.fee <= q.normal.fee && q.normal.fee <= q.fast.fee);
  assert.ok(q.slow.fee >= q.base_fee_gwei);
});

test("real /v1/quick: fee params for each profile, in wei, exactly", async () => {
  // base 0.1141 gwei; slow 0.1195, normal 0.1737, fast 0.5372 (base + tip).
  // maxFeePerGas = base * 2 + tip; maxPriorityFeePerGas = tip.
  const expected = {
    saver: { tip: 5_400_000n, max: 233_600_000n }, //    0.0054, 0.2282 + 0.0054
    balanced: { tip: 59_600_000n, max: 287_800_000n }, // 0.0596, 0.2282 + 0.0596
    priority: { tip: 423_100_000n, max: 651_300_000n }, // 0.4231, 0.2282 + 0.4231
  };
  const { client } = replay({ "/v1/quick": { body: QUICK } });
  for (const [profile, want] of Object.entries(expected)) {
    const f = await client.getFeeParams({ profile });
    assert.equal(f.maxPriorityFeePerGas, want.tip, `${profile} tip`);
    assert.equal(f.maxFeePerGas, want.max, `${profile} maxFee`);
    assert.equal(f.source.endpoint, "/v1/quick");
    assert.equal(f.source.profile, profile);
    assert.equal(f.source.baseFeeGwei, 0.1141);
  }
});

test("real /v1/advanced: confidence-targeted fee params, in wei, exactly", async () => {
  // fee 0.2258 = base 0.1141 + tip 0.1117; maxFee = 0.2282 + 0.1117.
  const { client, calls } = replay({ "/v1/advanced": { body: ADVANCED } });
  const f = await client.getFeeParams({ confidence: 0.9, blocks: 3 });
  assert.equal(f.maxPriorityFeePerGas, 111_700_000n);
  assert.equal(f.maxFeePerGas, 339_900_000n);
  assert.equal(f.source.endpoint, "/v1/advanced");
  assert.equal(f.source.confidence, 0.9);
  assert.equal(f.source.blocks, 3);
  const qs = new URL(calls[0].url).searchParams;
  assert.equal(qs.get("confidence"), "0.9");
  assert.equal(qs.get("blocks"), "3");
});

test("real /v1/advice/save: the documented fields and the extra ones the API sends", async () => {
  const { client, calls } = replay({ "/v1/advice/save": { body: ADVICE } });
  const a = await client.getAdvice({ gasLimit: 21000, targetSavingPct: 10 });
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    chain: "eth",
    gasLimit: 21000,
    targetSavingPct: 10,
  });
  assert.equal(a.waitMinutes, 0);
  assert.equal(a.savePercent, 77.76);
  assert.equal(a.advisedFee, 0.1195);
  assert.equal(a.naiveFee, 0.5372);
  assert.equal(a.targetMet, true);
  // The advice recommends the Saver tier's fee: the two endpoints agree.
  assert.equal(a.advisedFee, QUICK.slow.fee);
});

test("real 422 body: invalid_param names the parameter", async () => {
  const { client } = replay({ "/v1/advanced": { status: 422, body: E422 } });
  await assert.rejects(client.getAdvanced({ confidence: 2 }), (err) => {
    assert.ok(err instanceof McfoError);
    assert.equal(err.code, "invalid_param");
    assert.equal(err.param, "confidence");
    assert.equal(err.status, 422);
    return true;
  });
});

test("real 503 body: feed_stale carries retryAfterSeconds from the body", async () => {
  const { client } = replay({ "/v1/quick": { status: 503, body: E503 } });
  await assert.rejects(client.getFeeParams(), (err) => {
    assert.equal(err.code, "feed_stale");
    assert.equal(err.retryAfterSeconds, 15);
    return true;
  });
});

test("a 200 that is not JSON (a proxy or login page) is a typed error, not a SyntaxError", async () => {
  const { client } = replay({ "/v1/quick": { status: 200, text: "<!doctype html><title>Sign in</title>" } });
  await assert.rejects(client.getQuote(), (err) => {
    assert.ok(err instanceof McfoError, `got ${err?.constructor?.name}`);
    assert.equal(err.code, "http_error");
    return true;
  });
});

test("a request that outlives timeoutMs is aborted and reported as network_error", async () => {
  const slow = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  const client = new McfoClient({ baseUrl: "https://api.test", fetch: slow, timeoutMs: 20 });
  await assert.rejects(client.getQuote(), (err) => err.code === "network_error");
});

test("an unmapped status (500) is http_error carrying the status and the API's error code", async () => {
  const { client } = replay({ "/v1/quick": { status: 500, body: { error: "internal" } } });
  await assert.rejects(client.getQuote(), (err) => {
    assert.equal(err.code, "http_error");
    assert.equal(err.status, 500);
    assert.match(err.message, /internal/);
    return true;
  });
});

test("without any fetch implementation the constructor says what to pass", () => {
  const original = globalThis.fetch;
  globalThis.fetch = undefined;
  try {
    assert.throws(() => new McfoClient(), /pass options\.fetch/);
  } finally {
    globalThis.fetch = original;
  }
});

test("a 502 with an HTML body (a proxy in front of the API) is http_error, not a parse crash", async () => {
  const { client } = replay({ "/v1/quick": { status: 502, text: "<html>Bad gateway</html>" } });
  await assert.rejects(client.getQuote(), (err) => {
    assert.equal(err.code, "http_error");
    assert.equal(err.status, 502);
    return true;
  });
});

test("feeParamsFromQuote: one recorded quote gives the same values as three getFeeParams calls", async () => {
  const { client, calls } = replay({ "/v1/quick": { body: QUICK } });
  for (const profile of ["saver", "balanced", "priority"]) {
    assert.deepEqual(feeParamsFromQuote(QUICK, { profile }), await client.getFeeParams({ profile }));
  }
  assert.equal(calls.length, 3, "getFeeParams makes one request per call; feeParamsFromQuote makes none");
  assert.equal(feeParamsFromQuote(QUICK).source.profile, "balanced");
  assert.equal(feeParamsFromQuote(QUICK, { profile: "saver", baseFeeMultiplier: 3 }).maxFeePerGas, 347_700_000n);
});

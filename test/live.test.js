// Live tests against the real API. Skipped unless MCFO_LIVE=1, so ordinary
// runs never depend on the network. CI runs them once a day (live.yml).
//
//   MCFO_LIVE=1 npm run test:live
//   MCFO_LIVE=1 MCFO_BASE_URL=https://staging.example npm run test:live
//
// They check invariants that must hold for any real snapshot, not fixed
// numbers: fees move every block. Five requests in total, well inside the
// free tier's 30 a minute.
import assert from "node:assert/strict";
import { test } from "node:test";

import { McfoClient, McfoError } from "../dist/index.js";

const live = process.env.MCFO_LIVE === "1";
const opts = { skip: live ? false : "set MCFO_LIVE=1 to run against the real API" };
const client = new McfoClient({
  baseUrl: process.env.MCFO_BASE_URL,
  apiKey: process.env.MCFO_API_KEY,
  timeoutMs: 10_000,
});

test("live /v1/quick: a fresh quote with ordered tiers", opts, async () => {
  const q = await client.getQuote();
  assert.ok(q.base_fee_gwei > 0, "base fee is positive");
  assert.ok(q.slow.fee <= q.normal.fee && q.normal.fee <= q.fast.fee, "tiers are ordered");
  assert.ok(q.slow.fee >= q.base_fee_gwei, "no tier is below the base fee");
  assert.ok(q.snapshotAge < 30, `snapshot is fresh (${q.snapshotAge} s)`);
});

test("live getFeeParams: usable EIP-1559 values for every profile", opts, async () => {
  const [saver, balanced, priority] = await Promise.all(
    ["saver", "balanced", "priority"].map((profile) => client.getFeeParams({ profile })),
  );
  for (const f of [saver, balanced, priority]) {
    assert.equal(typeof f.maxFeePerGas, "bigint");
    assert.ok(f.maxFeePerGas > 0n);
    assert.ok(f.maxFeePerGas >= f.maxPriorityFeePerGas, "maxFee covers the tip");
  }
  assert.ok(saver.maxPriorityFeePerGas <= balanced.maxPriorityFeePerGas);
  assert.ok(balanced.maxPriorityFeePerGas <= priority.maxPriorityFeePerGas);
});

test("live /v1/advice/save: a recommendation the endpoint documents", opts, async () => {
  const a = await client.getAdvice({ gasLimit: 21000 });
  assert.ok(a.waitMinutes >= 0);
  assert.ok(a.confidence >= 0 && a.confidence <= 1);
  assert.equal(typeof a.estFutureMaxFee, "number");
});

test("live: an out-of-range parameter comes back as a typed invalid_param", opts, async () => {
  await assert.rejects(client.getAdvanced({ confidence: 2 }), (err) => {
    assert.ok(err instanceof McfoError);
    assert.equal(err.code, "invalid_param");
    assert.equal(err.param, "confidence");
    return true;
  });
});

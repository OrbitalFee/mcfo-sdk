// Live tests against the real API. Skipped unless MCFO_LIVE=1, so ordinary
// runs never depend on the network. CI runs them once a day (live.yml).
//
//   MCFO_LIVE=1 npm run test:live
//   MCFO_LIVE=1 MCFO_BASE_URL=https://staging.example npm run test:live
//
// They check invariants that must hold for any real snapshot, not fixed
// numbers: fees move every block. Seven requests in total, well inside the
// free tier's 30 a minute.
import assert from "node:assert/strict";
import { test } from "node:test";

import { McfoClient, McfoError } from "../dist/index.js";

const live = process.env.MCFO_LIVE === "1";
const opts = { skip: live ? false : "set MCFO_LIVE=1 to run against the real API" };
const accessHeaders =
  process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET
    ? {
        "CF-Access-Client-Id": process.env.CF_ACCESS_CLIENT_ID,
        "CF-Access-Client-Secret": process.env.CF_ACCESS_CLIENT_SECRET,
      }
    : undefined;
const client = new McfoClient({
  baseUrl: process.env.MCFO_BASE_URL,
  apiKey: process.env.MCFO_API_KEY,
  headers: accessHeaders, // Cloudflare Access service token, when the API needs one
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

test("live /v1/btc/quick: served tiers at or above their floors, odds only where measured", opts, async () => {
  const q = await client.btcQuick({ vsize: 140 });
  assert.equal(q.chain, "btc");
  assert.ok(["floored", "contested", "flat"].includes(q.marketState));
  assert.ok(q.snapshotAge < 90, `snapshot is fresh (${q.snapshotAge} s)`);
  for (const [name, tier] of Object.entries(q.tiers)) {
    assert.ok(tier.satVb > 0, `${name} rate is positive`);
    assert.ok(tier.satVb >= tier.rawSatVb - 1e-9, `${name} served rate is never below the queue's`);
    if (tier.landsNextBlockPct != null) {
      assert.ok(tier.landsNextBlockPct >= 0 && tier.landsNextBlockPct <= 100, `${name} odds are a percentage`);
    }
  }
  assert.ok(q.tiers.saver.satVb <= q.tiers.balanced.satVb && q.tiers.balanced.satVb <= q.tiers.priority.satVb);
  if (q.reliability) {
    assert.ok(["floored", "aboveFloor", "all"].includes(q.reliability.basis));
    assert.equal(typeof q.reliability.stale, "boolean");
    assert.equal(q.reliability.horizonBlocks, 1);
  }
});

test("live /v1/btc/providers: the public estimators beside our rate", opts, async () => {
  const p = await client.btcProviders();
  assert.equal(p.chain, "btc");
  assert.ok(p.providers.length >= 1);
  assert.ok(p.providers.some((r) => r.provider === "mempool.space"));
});

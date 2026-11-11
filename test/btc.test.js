// T41 — Bitcoin: recorded responses replayed through McfoClient.
//
// Fixtures:
//   btc-quick-floored.json   GET /v1/btc/quick?vsize=140 from the live API
//                            (mcfo.zgos.eu, 2026-11-11 06:40 UTC): a floored
//                            market, production floors (priority 1.0,
//                            balanced/saver 0.4), stored CoinGecko price.
//   btc-quick-contested.json the same route served by the real API router
//                            (product/api/routers/btc.py, 2026-11-11) from a
//                            contested queue (20/10/6/3/1.5 sat/vB, one block
//                            each) with the same floors and price. Production
//                            has been floored since October, so a contested
//                            quote cannot be recorded live today; the router
//                            and its reliability table are the production code.
//   btc-providers.json, btc-history.json  live, same minute as the floored quote.
//
// The rule under test is the one product-spec §16 states: odds are PASSED
// THROUGH, never computed here, and a stale or missing measurement stays
// visible to the caller.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { McfoClient, McfoError } from "../dist/index.js";

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

const FLOORED = fixture("btc-quick-floored");
const CONTESTED = fixture("btc-quick-contested");
const PROVIDERS = fixture("btc-providers");
const HISTORY = fixture("btc-history");
const E503_HISTORY = fixture("error-503-btc-history-unavailable");

function replay(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const { status = 200, body, headers = {} } = routes[path] ?? { status: 404, body: {} };
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k) => headers[k.toLowerCase()] ?? null },
      json: async () => body,
    };
  };
  return { client: new McfoClient({ baseUrl: "https://api.test", fetch: fetchImpl }), calls };
}

test("btcQuick: the request carries vsize, btc_usd and allow_sub_relay only when given", async () => {
  const { client, calls } = replay({ "/v1/btc/quick": { body: FLOORED } });
  await client.btcQuick();
  assert.equal(new URL(calls[0].url).search, "", "no params by default: the API's own defaults apply");
  await client.btcQuick({ vsize: 382, btcUsd: 70000, allowSubRelay: true });
  const qs = new URL(calls[1].url).searchParams;
  assert.equal(qs.get("vsize"), "382");
  assert.equal(qs.get("btc_usd"), "70000");
  assert.equal(qs.get("allow_sub_relay"), "true");
  await client.btcQuick({ allowSubRelay: false });
  assert.equal(new URL(calls[2].url).search, "", "allow_sub_relay false is the default, so it is not sent");
});

test("floored market, recorded live: tiers collapse to their floors and blocks are null", async () => {
  const { client } = replay({ "/v1/btc/quick": { body: FLOORED } });
  const q = await client.btcQuick({ vsize: 140 });
  assert.equal(q.chain, "btc");
  assert.equal(q.marketState, "floored");
  assert.equal(q.tiers.priority.satVb, 1.0);
  assert.equal(q.tiers.balanced.satVb, 0.4);
  assert.equal(q.tiers.saver.satVb, 0.4);
  assert.equal(q.tiers.priority.rawSatVb, 0.12, "the queue's own rate is kept beside the floored one");
  assert.equal(q.tiers.priority.floorSatVb, 1.0);
  assert.equal(q.tiers.saver.floorSatVb, 0.4);
  assert.equal(q.relayFloorSatVb, 0.4, "the lowest floor served");
  assert.deepEqual(q.tierFloorsSatVb, { priority: 1.0, balanced: 0.4, saver: 0.4 });
  for (const tier of Object.values(q.tiers)) {
    assert.equal(tier.blocks, null, "three prices at the floor cannot carry three block counts (B47)");
    assert.equal(tier.etaMinutes, null);
    assert.equal(tier.belowRelayFloor, true);
  }
  assert.equal(q.marginalSatVb, 0.12);
  assert.equal(q.vsizeAssumed, 140);
  assert.equal(typeof q.subRelayCaveat, "string");
});

test("floored market: the measured odds per floor are passed through exactly, with the price behind usd", async () => {
  const { client } = replay({ "/v1/btc/quick": { body: FLOORED } });
  const q = await client.btcQuick({ vsize: 140 });
  // Per-floor odds from docs/technical/btc-floor-rescore.md (B64, T-B18).
  assert.equal(q.tiers.priority.landsNextBlockPct, 72.7);
  assert.equal(q.tiers.priority.landsWithin3BlocksPct, 95.3);
  assert.equal(q.tiers.priority.landsWithin6BlocksPct, 98.9);
  assert.equal(q.tiers.balanced.landsNextBlockPct, 49.5);
  assert.equal(q.tiers.saver.landsWithin6BlocksPct, 95.1);
  // usd = satVb × vsize × price / 1e8, to 4 dp (T-PX1): 1.0 × 140 × 73778 / 1e8.
  assert.equal(q.priceUsd, 73778.0);
  assert.equal(q.priceSource, "coingecko");
  assert.equal(q.tiers.priority.usd, 0.1033);
  assert.equal(q.tiers.balanced.usd, 0.0413);
  assert.equal(Number(((1.0 * 140 * 73778) / 1e8).toFixed(4)), q.tiers.priority.usd);
});

test("floored market: reliability names its population, window and sample, and is not stale", async () => {
  const { client } = replay({ "/v1/btc/quick": { body: FLOORED } });
  const r = (await client.btcQuick()).reliability;
  assert.equal(r.basis, "floored");
  assert.equal(r.measuredOn, "2026-10-12");
  assert.equal(r.window, "2026-10-04T18:45Z/2026-10-12T05:19Z");
  assert.equal(r.quotesScored, 7590);
  assert.equal(r.blocksScored, 965);
  assert.equal(r.servedLandsNextBlockPct, 72.7);
  assert.equal(r.rawLandsNextBlockPct, 6.3);
  assert.equal(r.providerLandsNextBlockPct, 86.5);
  assert.equal(r.medianSavingVsProviderPct, 0.0, "at the floor the provider recommends the same rate: no saving");
  assert.equal(r.horizonBlocks, 1);
  assert.equal(r.horizon, "the next real block");
  assert.equal(r.stale, false);
  assert.equal(r.measuredTier, "priority");
});

test("contested market, recorded from the real router: distinct prices, block counts, one measured tier", async () => {
  const { client } = replay({ "/v1/btc/quick": { body: CONTESTED } });
  const q = await client.btcQuick({ vsize: 140 });
  assert.equal(q.marketState, "contested");
  assert.deepEqual(
    [q.tiers.saver.satVb, q.tiers.balanced.satVb, q.tiers.priority.satVb],
    [3.0, 10.0, 20.0],
  );
  assert.deepEqual(
    [q.tiers.saver.blocks, q.tiers.balanced.blocks, q.tiers.priority.blocks],
    [4, 2, 1],
  );
  assert.deepEqual(
    [q.tiers.saver.etaMinutes, q.tiers.balanced.etaMinutes, q.tiers.priority.etaMinutes],
    [40, 20, 10],
  );
  for (const tier of Object.values(q.tiers)) assert.equal(tier.belowRelayFloor, false);
  // Only the measured tier carries odds; the cheaper tiers sit below the
  // measured rate and are deliberately NOT given an interpolated number (§16).
  assert.equal(q.tiers.priority.landsNextBlockPct, 14.4);
  assert.equal("landsNextBlockPct" in q.tiers.balanced, false);
  assert.equal("landsNextBlockPct" in q.tiers.saver, false);
  assert.equal(q.tiers.priority.usd, 2.0658); // 20 × 140 × 73778 / 1e8
  assert.equal(q.providerFastestSatVb, 4.0);
  assert.equal(q.subRelayCaveat, null, "nothing below the floor, so no caveat");
});

test("contested market: reliability is the above-floor population and says the next block is a long shot", async () => {
  const { client } = replay({ "/v1/btc/quick": { body: CONTESTED } });
  const r = (await client.btcQuick()).reliability;
  assert.equal(r.basis, "aboveFloor");
  assert.equal(r.quotesScored, 2924);
  assert.equal(r.blocksScored, 364);
  assert.equal(r.servedLandsNextBlockPct, 14.4);
  assert.equal(r.providerLandsNextBlockPct, 91.6);
  assert.equal(r.medianSavingVsProviderPct, 50.0);
  assert.equal(r.sharedByAllTiers, false);
  assert.equal(r.stale, false);
});

test("a stale measurement stays visible: the SDK neither hides nor recomputes it", async () => {
  const stale = structuredClone(FLOORED);
  stale.reliability.stale = true;
  stale.reliability.ageDays = 44;
  for (const tier of Object.values(stale.tiers)) {
    delete tier.landsNextBlockPct;
    delete tier.landsWithin3BlocksPct;
    delete tier.landsWithin6BlocksPct;
  }
  const { client } = replay({ "/v1/btc/quick": { body: stale } });
  const q = await client.btcQuick();
  assert.equal(q.reliability.stale, true);
  assert.equal(q.reliability.ageDays, 44);
  assert.equal(q.reliability.servedLandsNextBlockPct, 72.7, "the expired figure is still there for the caller to judge");
  assert.equal(q.tiers.priority.landsNextBlockPct, undefined, "withdrawn odds are absent, not invented");
});

test("a quote with no reliability block at all is served as-is", async () => {
  const none = structuredClone(CONTESTED);
  none.reliability = null;
  const { client } = replay({ "/v1/btc/quick": { body: none } });
  const q = await client.btcQuick();
  assert.equal(q.reliability, null);
  assert.equal(q.tiers.priority.satVb, 20.0);
});

test("depth is a vector of weight at or above a rate, never a total", async () => {
  const { client } = replay({ "/v1/btc/quick": { body: FLOORED } });
  const q = await client.btcQuick();
  assert.ok(Array.isArray(q.depth) && q.depth.length >= 5);
  assert.deepEqual(Object.keys(q.depth[0]).sort(), ["blocks", "min_sat_vb", "vsize"]);
  assert.equal(q.depth[0].min_sat_vb, 0.1);
  assert.equal(q.depth[0].blocks, 31.647);
  assert.equal(q.depth[2].min_sat_vb, 1.0);
  assert.equal(q.depth[2].blocks, 0.101, "32 blocks of queue at 0.1 sat/vB, a tenth of one at 1 (§16)");
  assert.equal("totalVsize" in q, false);
});

test("btcProviders, recorded live: every estimator beside the served rate, with the queue flag", async () => {
  const { client, calls } = replay({ "/v1/btc/providers": { body: PROVIDERS } });
  const p = await client.btcProviders();
  assert.equal(new URL(calls[0].url).pathname, "/v1/btc/providers");
  assert.equal(p.chain, "btc");
  assert.equal(p.queueAvailable, true);
  assert.equal(p.marginalSatVb, 0.12);
  assert.deepEqual(
    p.providers.map((r) => r.provider),
    ["mempool.space", "blockstream", "blockchain.com"],
  );
  const ms = p.providers[0];
  assert.equal(ms.next_block_sat_vb, 1.0);
  assert.equal(ms.economy_sat_vb, 1.0);
  assert.equal(ms.vs_mcfo_ratio, 8.333);
  assert.equal(ms.overpay_pct, 88.0, "measured against the raw queue rate, as the API serves it");
  assert.equal(ms.note, null);
  assert.equal(typeof p.snapshotAge, "number");
});

test("btcProviders: a mempool.space outage is queueAvailable false with the other rows kept", async () => {
  const down = structuredClone(PROVIDERS);
  down.queueAvailable = false;
  down.marginalSatVb = null;
  down.providers = down.providers.slice(1).map((r) => ({ ...r, vs_mcfo_ratio: null, overpay_pct: null }));
  const { client } = replay({ "/v1/btc/providers": { body: down } });
  const p = await client.btcProviders();
  assert.equal(p.queueAvailable, false);
  assert.equal(p.marginalSatVb, null);
  assert.equal(p.providers.length, 2);
  assert.equal(p.providers[0].overpay_pct, null);
});

test("btcHistory, recorded live: oldest first, ts in epoch seconds, default window a day", async () => {
  const { client, calls } = replay({ "/v1/btc/history": { body: HISTORY } });
  const h = await client.btcHistory();
  assert.equal(new URL(calls[0].url).searchParams.get("minutes"), "1440");
  assert.equal(h.length, 3);
  assert.ok(h[0].ts < h[1].ts && h[1].ts < h[2].ts, "ascending");
  assert.ok(h[0].ts > 1_700_000_000 && h[0].ts < 2_000_000_000, "epoch seconds, not milliseconds");
  assert.equal(h[0].marginalSatVb, 0.144);
  assert.equal(h[0].providerFastestSatVb, 1.0);
  assert.equal(h[0].overpayRatio, 6.944);
  await client.btcHistory({ minutes: 10080 });
  assert.equal(new URL(calls[1].url).searchParams.get("minutes"), "10080");
});

test("btcHistory: an empty window is [] (true), a read failure is a 503 typed error (never [])", async () => {
  const { client } = replay({ "/v1/btc/history": { body: [] } });
  assert.deepEqual(await client.btcHistory({ minutes: 1 }), []);
  const broken = replay({ "/v1/btc/history": { status: 503, body: E503_HISTORY } });
  await assert.rejects(broken.client.btcHistory(), (err) => {
    assert.ok(err instanceof McfoError);
    assert.equal(err.code, "feed_stale");
    assert.equal(err.status, 503);
    assert.equal(err.retryAfterSeconds, 15);
    assert.match(err.message, /btc_history_unavailable/, "the API's own reason is in the message");
    return true;
  });
});

test("btcQuick: 503 feed_stale past the 90 s budget and 422 for a vsize out of range", async () => {
  const stale = replay({
    "/v1/btc/quick": { status: 503, body: { error: "feed_stale", retryAfterSeconds: 15 }, headers: { "retry-after": "15" } },
  });
  await assert.rejects(stale.client.btcQuick(), (err) => err.code === "feed_stale" && err.retryAfterSeconds === 15);
  const bad = replay({ "/v1/btc/quick": { status: 422, body: { error: "invalid_param", param: "vsize" } } });
  await assert.rejects(bad.client.btcQuick({ vsize: 0 }), (err) => err.code === "invalid_param" && err.param === "vsize");
});

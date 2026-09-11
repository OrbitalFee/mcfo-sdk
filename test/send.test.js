// T29 — sendTransaction: fee merging and delegation to the caller's wallet.
// Both fakes stand in for the real clients; the SDK must never need keys.
import assert from "node:assert/strict";
import { test } from "node:test";

import { McfoClient, gweiToWei, isViemWalletClient, sendTransaction } from "../dist/index.js";

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

function quoteClient() {
  return new McfoClient({
    baseUrl: "https://api.test",
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => QUOTE,
    }),
  });
}

/** ethers v6 Signer shape: sendTransaction -> TransactionResponse. */
function fakeEthersSigner(seen) {
  return {
    async sendTransaction(tx) {
      seen.push(tx);
      return { hash: "0xethers", wait: async () => ({ status: 1 }) };
    },
  };
}

/** viem WalletClient shape: account + transport, sendTransaction -> hash. */
function fakeViemClient(seen) {
  return {
    account: { address: "0xabc" },
    transport: { type: "http" },
    chain: { id: 1 },
    async sendTransaction(tx) {
      seen.push(tx);
      return "0xviem";
    },
  };
}

test("wallet kinds are discriminated structurally", () => {
  assert.equal(isViemWalletClient(fakeViemClient([])), true);
  assert.equal(isViemWalletClient(fakeEthersSigner([])), false);
});

test("ethers path: fees merged, tx delegated, hash normalised", async () => {
  const seen = [];
  const result = await sendTransaction(quoteClient(), fakeEthersSigner(seen), {
    to: "0xdead",
    value: 1n,
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].to, "0xdead");
  assert.equal(seen[0].maxPriorityFeePerGas, gweiToWei(0.5)); // balanced tip
  assert.equal(seen[0].maxFeePerGas, gweiToWei(40.5)); // base*2 + tip
  assert.equal(result.hash, "0xethers");
  assert.equal(result.raw.hash, "0xethers");
  assert.equal(result.feeParams.source.profile, "balanced");
});

test("viem path: same fees, hash returned directly", async () => {
  const seen = [];
  const result = await sendTransaction(quoteClient(), fakeViemClient(seen), { to: "0xdead" }, {
    profile: "priority",
  });

  assert.equal(seen[0].maxPriorityFeePerGas, gweiToWei(1.0)); // fast tip
  assert.equal(result.hash, "0xviem");
  assert.equal(result.raw, "0xviem");
});

test("caller-supplied fees always win over MCFO's", async () => {
  const seen = [];
  await sendTransaction(quoteClient(), fakeEthersSigner(seen), {
    to: "0xdead",
    maxFeePerGas: 123n,
    maxPriorityFeePerGas: 7n,
  });
  assert.equal(seen[0].maxFeePerGas, 123n);
  assert.equal(seen[0].maxPriorityFeePerGas, 7n);
});

test("feeParams can be reused without a second API call", async () => {
  let calls = 0;
  const client = new McfoClient({
    baseUrl: "https://api.test",
    fetch: async () => {
      calls += 1;
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => QUOTE };
    },
  });
  const feeParams = await client.getFeeParams({ profile: "saver" });
  assert.equal(calls, 1);

  const seen = [];
  await sendTransaction(client, fakeEthersSigner(seen), { to: "0xdead" }, { feeParams });
  assert.equal(calls, 1); // no refetch
  assert.equal(seen[0].maxPriorityFeePerGas, feeParams.maxPriorityFeePerGas);
});

test("API failures propagate instead of submitting an unpriced transaction", async () => {
  const client = new McfoClient({
    baseUrl: "https://api.test",
    fetch: async () => ({
      ok: false,
      status: 503,
      headers: { get: () => null },
      json: async () => ({ error: "feed_stale", retryAfterSeconds: 15 }),
    }),
  });
  const seen = [];
  const err = await sendTransaction(client, fakeEthersSigner(seen), { to: "0xdead" }).catch((e) => e);
  assert.equal(err.code, "feed_stale");
  assert.equal(seen.length, 0); // nothing was sent
});

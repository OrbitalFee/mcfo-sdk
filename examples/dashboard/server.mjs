// A small live fee dashboard built on @orbitalfee/mcfo-sdk.
//
//   npm run build && node examples/dashboard/server.mjs
//   open http://localhost:8787
//
// The SDK runs here, on the server, and the page only talks to this server:
//   - an API key (MCFO_API_KEY) stays on the server and never reaches a browser;
//   - the Orbital Fee API does not answer cross-origin browser requests, so a
//     page cannot call it directly anyway;
//   - one cache serves every open tab, which keeps a busy page inside the free
//     tier's 30 requests a minute.
// No dependencies besides the SDK.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { McfoClient, McfoError, feeParamsFromQuote } from "@orbitalfee/mcfo-sdk";

const PORT = Number(process.env.PORT ?? 8787);
const REFRESH_MS = 15_000;
const GAS_LIMITS = [21_000, 65_000, 150_000]; // transfer, token transfer, swap
// Profile -> the /v1/quick tier it reads.
const PROFILES = { saver: "slow", balanced: "normal", priority: "fast" };

const accessHeaders =
  process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET
    ? {
        "CF-Access-Client-Id": process.env.CF_ACCESS_CLIENT_ID,
        "CF-Access-Client-Secret": process.env.CF_ACCESS_CLIENT_SECRET,
      }
    : undefined;
const mcfo = new McfoClient({
  apiKey: process.env.MCFO_API_KEY,
  baseUrl: process.env.MCFO_BASE_URL,
  headers: accessHeaders,
});

/** Last good market snapshot, shared by every gas limit and every tab. */
let market = { data: null, at: 0, error: null, retryAt: 0 };
/** Advice per gas limit, since the endpoint takes the gas limit as input. */
const advice = new Map();

const wei = (v) => v.toString(); // JSON has no bigint

async function loadMarket() {
  const now = Date.now();
  if (now - market.at < REFRESH_MS || now < market.retryAt) return;
  try {
    // Two API calls per refresh: one quote gives all three profiles
    // (feeParamsFromQuote), plus the confidence-targeted fee.
    const quote = await mcfo.getQuote();
    const profiles = {};
    for (const [profile, tier] of Object.entries(PROFILES)) {
      const f = feeParamsFromQuote(quote, { profile });
      profiles[profile] = {
        feeGwei: quote[tier].fee,
        savingPct: quote[tier].savingPct ?? null,
        tipGwei: f.source.tipGwei,
        maxFeePerGas: wei(f.maxFeePerGas),
        maxPriorityFeePerGas: wei(f.maxPriorityFeePerGas),
      };
    }
    const target = await mcfo.getFeeParams({ confidence: 0.9, blocks: 3 });
    market = {
      data: {
        baseFeeGwei: quote.base_fee_gwei,
        snapshotAge: quote.snapshotAge,
        generatedAt: quote.generatedAt ?? null,
        naiveFee: quote.naiveFee ?? null,
        savingBasis: quote.savingBasis ?? null,
        profiles,
        confidence: {
          confidence: 0.9,
          blocks: 3,
          tipGwei: target.source.tipGwei,
          feeGwei: target.source.baseFeeGwei + target.source.tipGwei,
          maxFeePerGas: wei(target.maxFeePerGas),
          maxPriorityFeePerGas: wei(target.maxPriorityFeePerGas),
        },
      },
      at: now,
      error: null,
      retryAt: 0,
    };
  } catch (err) {
    market.error = describe(err);
    market.retryAt = now + (err.retryAfterSeconds ?? 15) * 1000;
  }
}

async function loadAdvice(gasLimit) {
  const now = Date.now();
  const cached = advice.get(gasLimit) ?? { data: null, at: 0, error: null, retryAt: 0 };
  if (now - cached.at < REFRESH_MS || now < cached.retryAt) return cached;
  try {
    const a = await mcfo.getAdvice({ gasLimit, targetSavingPct: 10 });
    const next = { data: a, at: now, error: null, retryAt: 0 };
    advice.set(gasLimit, next);
    return next;
  } catch (err) {
    const next = { ...cached, error: describe(err), retryAt: now + (err.retryAfterSeconds ?? 15) * 1000 };
    advice.set(gasLimit, next);
    return next;
  }
}

function describe(err) {
  if (err instanceof McfoError) {
    return { code: err.code, message: err.message, retryAfterSeconds: err.retryAfterSeconds ?? null };
  }
  return { code: "unexpected", message: String(err), retryAfterSeconds: null };
}

const page = new URL("./index.html", import.meta.url);

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    res.end(await readFile(page));
    return;
  }
  if (url.pathname === "/api/fees") {
    const gasLimit = Number(url.searchParams.get("gasLimit"));
    if (!GAS_LIMITS.includes(gasLimit)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "gasLimit must be one of " + GAS_LIMITS.join(", ") }));
      return;
    }
    await loadMarket();
    const a = await loadAdvice(gasLimit);
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({
      gasLimit,
      gasLimits: GAS_LIMITS,
      market: market.data,
      marketAgeMs: market.at ? Date.now() - market.at : null,
      marketError: market.error,
      advice: a.data,
      adviceError: a.error,
    }));
    return;
  }
  res.writeHead(404).end();
}).listen(PORT, () => {
  console.log(`Orbital Fee dashboard on http://localhost:${PORT}`);
});

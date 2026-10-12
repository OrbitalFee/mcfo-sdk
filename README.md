# @orbitalfee/mcfo-sdk

[![CI](https://github.com/OrbitalFee/mcfo-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/OrbitalFee/mcfo-sdk/actions/workflows/ci.yml)
[![Live API](https://github.com/OrbitalFee/mcfo-sdk/actions/workflows/live.yml/badge.svg)](https://github.com/OrbitalFee/mcfo-sdk/actions/workflows/live.yml)
[![npm](https://img.shields.io/npm/v/@orbitalfee/mcfo-sdk)](https://www.npmjs.com/package/@orbitalfee/mcfo-sdk)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Fee selection for Ethereum transactions from [Orbital Fee](https://mcfo.zgos.eu).

The first release covers Ethereum. Bitcoin support is planned.

Two layers, both usable on their own:

1. **`McfoClient`** — typed access to `/v1/quick`, `/v1/advice/save` and
   `/v1/advanced`, plus `getFeeParams()` which returns EIP-1559 values in wei.
2. **`sendTransaction()`** — merges those fees into a transaction and hands it
   to *your* ethers `Signer` or viem `WalletClient` for signing and submission.

**The SDK never handles private keys.** Signing and submission stay with
your own wallet client. Key management and autonomous submission are out of
scope.

## Install

```bash
npm install @orbitalfee/mcfo-sdk
# plus whichever client you already use:
npm install ethers      # or: npm install viem
```

Node 18+ (uses the global `fetch`). Use the SDK on a server: the Orbital Fee
API does not answer cross-origin requests from browsers, and an API key must
never be shipped to a browser anyway. The [dashboard example](#a-live-dashboard)
shows the pattern: the SDK on your server, your page talks to your server. Both `ethers` and `viem` are *optional*
peer dependencies — the SDK depends on neither at runtime, only on their
public method shapes.

## Fee parameters only

```ts
import { McfoClient } from "@orbitalfee/mcfo-sdk";

const mcfo = new McfoClient({ apiKey: process.env.MCFO_API_KEY }); // anonymous = free tier

const fees = await mcfo.getFeeParams({ profile: "saver" });
// { maxFeePerGas: 40100000000n, maxPriorityFeePerGas: 100000000n, source: {...} }

await wallet.sendTransaction({ to, value, ...fees }); // your wallet, your keys
```

Profiles map onto `/v1/quick`'s tiers: `saver` → slow, `balanced` → normal
(default), `priority` → fast. `maxFeePerGas` carries headroom for base-fee
growth — `baseFee × baseFeeMultiplier + tip`, multiplier 2 by default.

Need all three profiles? Fetch the quote once and derive them, so one request
does the work of three:

```ts
import { McfoClient, feeParamsFromQuote } from "@orbitalfee/mcfo-sdk";

const quote = await mcfo.getQuote();
const saver = feeParamsFromQuote(quote, { profile: "saver" });
const fast = feeParamsFromQuote(quote, { profile: "priority" });
```

For confidence-targeted pricing (`/v1/advanced`), pass `confidence` and/or
`blocks` instead of a profile:

```ts
const fees = await mcfo.getFeeParams({ confidence: 0.95, blocks: 2 });
```

## With submission

```ts
import { McfoClient, sendTransaction } from "@orbitalfee/mcfo-sdk";

const { hash, feeParams } = await sendTransaction(
  mcfo,
  signer,                       // ethers Signer or viem WalletClient
  { to: "0x…", value: 10n ** 16n },
  { profile: "balanced" },
);
```

Fees you set explicitly on the transaction always win — the SDK only fills
gaps. If the API is unavailable the call throws **before** anything is sent,
so a transaction is never submitted unpriced.

## Errors

Every failure is an `McfoError` with a `code`:

| code | meaning |
|---|---|
| `feed_stale` | 503 — collector feed is stale; `retryAfterSeconds` is set |
| `rate_limited` | 429 — tier limit hit; `retryAfterSeconds` from `Retry-After` |
| `invalid_api_key` | 401 — key unknown or revoked |
| `invalid_param` | 422 — `param` names the offending field |
| `http_error` / `network_error` | anything else / transport failure |

## Examples

Each example runs from a clone of this repository after `npm ci && npm run build`.
Inside the repository `@orbitalfee/mcfo-sdk` resolves to the local build, so the
files run unchanged in your own project after `npm install @orbitalfee/mcfo-sdk`.

| Example | What it shows |
|---|---|
| [`examples/quick-fees.mjs`](examples/quick-fees.mjs) | The three profiles from the live API, in gwei and wei, with typed error handling |
| [`examples/dry-run-transaction.mjs`](examples/dry-run-transaction.mjs) | `sendTransaction` with a recording wallet: confidence pricing, and a fee you set yourself winning over the SDK's |
| [`examples/dashboard/`](examples/dashboard/) | A live fee dashboard, below |

### A live dashboard

```bash
npm ci && npm run build
node examples/dashboard/server.mjs      # then open http://localhost:8787
```

![The example dashboard with live Ethereum fees](https://raw.githubusercontent.com/OrbitalFee/mcfo-sdk/main/docs/dashboard.jpg)

A Node server with no dependencies besides the SDK. It reads the live API on the
server (three requests every 15 seconds, shared by every open tab, so a busy page
stays inside the free tier's 30 a minute) and serves one page with:

- the Saver, Balanced and Priority fees, their cost for the chosen gas limit, and
  the `maxFeePerGas` / `maxPriorityFeePerGas` values ready to copy into a transaction;
- the fee for a 90% chance of inclusion within 3 blocks;
- the advice (send now or wait) for the chosen gas limit;
- the last good reading and the reason when the API is unavailable or rate-limited.

Set `MCFO_API_KEY` to use a paid tier; the key stays on the server.

## Tests

```bash
npm test               # everything below except the live suite
npm run test:unit      # unit and contract tests
npm run test:coverage  # the same, failing below 95% line/function and 90% branch coverage
npm run test:package   # pack, install, import by name, type-check a TypeScript consumer
npm run test:live      # against the real API (needs network)
```

| Suite | What it proves |
|---|---|
| `test/client.test.js` | Fee arithmetic, headers, and the mapping of every API error to `McfoError` |
| `test/send.test.js` | Fees merged into the transaction, delegation to ethers and viem, your own fees always win |
| `test/contract.test.js` | Responses recorded from the live API replayed through the client, with every derived wei value checked exactly; proxy pages, timeouts and unknown statuses become typed errors |
| `test/package.test.js` | What `npm install` delivers: the tarball contents, the exports, and the shipped type declarations |
| `test/live.test.js` | Invariants of the real API (fresh snapshot, ordered tiers, usable EIP-1559 values). Skipped unless `MCFO_LIVE=1` |

CI runs the unit tests on Node 18, 20 and 22, then coverage and the package test.
The live suite runs every day. A red "Live API" badge means the API changed or is
down, not that the SDK broke.

No test framework: Node's built-in runner, against the compiled output, so the
only development dependency is TypeScript.

## License

MIT. See [LICENSE](LICENSE).

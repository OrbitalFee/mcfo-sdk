# @orbitalfee/mcfo-sdk

MCFO fee selection for Ethereum transactions (T29).

Two layers, both usable on their own:

1. **`McfoClient`** — typed access to `/v1/quick`, `/v1/advice/save` and
   `/v1/advanced`, plus `getFeeParams()` which returns EIP-1559 values in wei.
2. **`sendTransaction()`** — merges those fees into a transaction and hands it
   to *your* ethers `Signer` or viem `WalletClient` for signing and submission.

**The SDK never handles private keys.** Key management and autonomous
submission are deliberately out of scope (product-spec §1 defers wallet
integration pending security + legal review; T30 owns the smart tx queue).

## Install

```bash
npm install @orbitalfee/mcfo-sdk
# plus whichever client you already use:
npm install ethers      # or: npm install viem
```

Node 18+ (uses the global `fetch`). Both `ethers` and `viem` are *optional*
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

## Development

```bash
npm install
npm test        # builds, then runs node:test against dist/
```

No test framework: tests use Node's built-in runner against the compiled
output, keeping the dependency surface to TypeScript alone.

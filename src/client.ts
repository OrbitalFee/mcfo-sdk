import {
  Advice,
  AdvancedQuote,
  Chain,
  FeeParams,
  FeeProfile,
  McfoError,
  Quote,
} from "./types.js";

const DEFAULT_BASE_URL = "https://mcfo.zgos.eu";
const DEFAULT_TIMEOUT_MS = 5000;
/** maxFeePerGas headroom for base-fee growth: base * N + tip. */
const DEFAULT_BASE_FEE_MULTIPLIER = 2;

const PROFILE_TIER: Record<FeeProfile, keyof Pick<Quote, "slow" | "normal" | "fast">> = {
  saver: "slow",
  balanced: "normal",
  priority: "fast",
};

export interface McfoClientOptions {
  /** API origin. Default: https://mcfo.zgos.eu */
  baseUrl?: string;
  /** Sent as X-API-Key; anonymous callers stay on the free tier (T-A2). */
  apiKey?: string;
  /** Injectable for tests / custom agents. Default: global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout. Default: 5000ms. */
  timeoutMs?: number;
  /**
   * Extra headers sent on every request, for example a Cloudflare Access
   * service token when the API sits behind a login:
   * `{ "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret }`.
   * They never override accept, content-type or X-API-Key.
   */
  headers?: Record<string, string>;
}

export function gweiToWei(gwei: number): bigint {
  // Route through a fixed-point string: Number arithmetic on 1e9 loses
  // precision for fractional gwei, and BigInt() rejects non-integers.
  return BigInt(Math.round(gwei * 1e9));
}

/**
 * EIP-1559 fee parameters for one profile, from a quote you already have.
 *
 * getFeeParams({ profile }) fetches /v1/quick and calls this. Call it
 * yourself to derive all three profiles from one request instead of three.
 */
export function feeParamsFromQuote(
  quote: Quote,
  options: { profile?: FeeProfile; baseFeeMultiplier?: number } = {},
): FeeParams {
  const profile = options.profile ?? "balanced";
  const baseFeeMultiplier = options.baseFeeMultiplier ?? DEFAULT_BASE_FEE_MULTIPLIER;
  const baseFeeGwei = quote.base_fee_gwei;
  // The API returns base + tip; the tip is what EIP-1559 calls the priority fee.
  const tipGwei = Math.max(quote[PROFILE_TIER[profile]].fee - baseFeeGwei, 0);
  return {
    maxFeePerGas: gweiToWei(baseFeeGwei * baseFeeMultiplier + tipGwei),
    maxPriorityFeePerGas: gweiToWei(tipGwei),
    source: { endpoint: "/v1/quick", profile, baseFeeGwei, tipGwei, baseFeeMultiplier },
  };
}

export class McfoClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: McfoClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.extraHeaders = { ...(options.headers ?? {}) };
    if (typeof this.fetchImpl !== "function") {
      throw new TypeError("No fetch implementation: pass options.fetch (Node < 18)");
    }
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          ...this.extraHeaders,
          accept: "application/json",
          ...(this.apiKey ? { "X-API-Key": this.apiKey } : {}),
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(init.headers ?? {}),
        },
      });
    } catch (cause) {
      throw new McfoError("network_error", `Request to ${path} failed: ${cause}`);
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) {
      // A proxy or login page can answer 200 with HTML. That is not a quote,
      // so it must surface as a typed error, never as a raw SyntaxError.
      try {
        return (await res.json()) as T;
      } catch {
        throw new McfoError("http_error", `${path} returned a body that is not JSON`, {
          status: res.status,
        });
      }
    }

    const body: Record<string, unknown> = await res.json().catch(() => ({}));
    const retryAfterHeader = Number(res.headers?.get?.("retry-after") ?? NaN);
    const retryAfter = Number.isFinite(retryAfterHeader)
      ? retryAfterHeader
      : typeof body.retryAfterSeconds === "number"
        ? body.retryAfterSeconds
        : undefined;
    const error = typeof body.error === "string" ? body.error : `http_${res.status}`;

    switch (res.status) {
      case 401:
        throw new McfoError("invalid_api_key", "API key missing, unknown or revoked", {
          status: 401,
        });
      case 422:
        throw new McfoError("invalid_param", `Invalid parameter: ${body.param ?? "?"}`, {
          status: 422,
          param: typeof body.param === "string" ? body.param : undefined,
        });
      case 429:
        throw new McfoError("rate_limited", "Rate limit exceeded for this tier", {
          status: 429,
          retryAfterSeconds: retryAfter,
        });
      case 503:
        throw new McfoError("feed_stale", "Fee feed is stale; retry shortly", {
          status: 503,
          retryAfterSeconds: retryAfter,
        });
      default:
        throw new McfoError("http_error", `${path} returned ${res.status} (${error})`, {
          status: res.status,
        });
    }
  }

  /** GET /v1/quick — fast/normal/slow tiers with confidence. */
  getQuote(chain: Chain = "eth"): Promise<Quote> {
    return this.request<Quote>(`/v1/quick?chain=${encodeURIComponent(chain)}`);
  }

  /** POST /v1/advice/save — wait-or-submit recommendation. */
  getAdvice(
    params: { chain?: Chain; gasLimit?: number; targetSavingPct?: number } = {},
  ): Promise<Advice> {
    const { chain = "eth", gasLimit = 21000, targetSavingPct = 10 } = params;
    return this.request<Advice>("/v1/advice/save", {
      method: "POST",
      body: JSON.stringify({ chain, gasLimit, targetSavingPct }),
    });
  }

  /** GET /v1/advanced — minimum fee meeting P(inclusion) within a block budget. */
  getAdvanced(
    params: { chain?: Chain; confidence?: number; blocks?: number } = {},
  ): Promise<AdvancedQuote> {
    const { chain = "eth", confidence = 0.9, blocks = 3 } = params;
    const qs = new URLSearchParams({
      chain,
      confidence: String(confidence),
      blocks: String(blocks),
    });
    return this.request<AdvancedQuote>(`/v1/advanced?${qs}`);
  }

  /**
   * EIP-1559 fee parameters in wei, ready to spread into a transaction.
   *
   * A profile reads /v1/quick's matching tier; passing `confidence` (and
   * optionally `blocks`) instead reads /v1/advanced. `maxFeePerGas` carries
   * headroom for base-fee growth: baseFee * baseFeeMultiplier + tip.
   */
  async getFeeParams(
    params: {
      chain?: Chain;
      profile?: FeeProfile;
      confidence?: number;
      blocks?: number;
      baseFeeMultiplier?: number;
    } = {},
  ): Promise<FeeParams> {
    const {
      chain = "eth",
      confidence,
      blocks,
      baseFeeMultiplier = DEFAULT_BASE_FEE_MULTIPLIER,
    } = params;

    if (confidence === undefined && blocks === undefined) {
      const quote = await this.getQuote(chain);
      return feeParamsFromQuote(quote, { profile: params.profile, baseFeeMultiplier });
    }

    const advanced = await this.getAdvanced({ chain, confidence, blocks });
    const baseFeeGwei = advanced.base_fee_gwei;
    // The API returns base + tip; the tip is what EIP-1559 calls the priority fee.
    const tipGwei = Math.max(advanced.fee - baseFeeGwei, 0);
    return {
      maxFeePerGas: gweiToWei(baseFeeGwei * baseFeeMultiplier + tipGwei),
      maxPriorityFeePerGas: gweiToWei(tipGwei),
      source: {
        endpoint: "/v1/advanced",
        confidence: advanced.confidenceRequested,
        blocks: advanced.blocks,
        baseFeeGwei,
        tipGwei,
        baseFeeMultiplier,
      },
    };
  }
}

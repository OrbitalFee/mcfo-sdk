/** Response and option types mirroring the MCFO v1 API (product-spec §7/§12). */

export type Chain = "eth";

/** Fee profile names map onto /v1/quick's tiers (spec §7). */
export type FeeProfile = "saver" | "balanced" | "priority";

export interface FeeTier {
  fee: number; // gwei, base + percentile tip
  unit: "gwei";
  confidence: number; // 0–1
  blocks: number;
  /** % below the quote's naive reference (naiveFee), when the API sends it. */
  savingPct?: number;
}

export interface Quote {
  fast: FeeTier;
  normal: FeeTier;
  slow: FeeTier;
  base_fee_gwei: number;
  gas_used_ratio_mean: number;
  gas_used_ratio_std: number;
  source: string;
  snapshotAge: number;
  generatedAt?: string;
  /** Reference fee the tier savings are measured against, in gwei. */
  naiveFee?: number;
  /** Plain-words name of that reference, e.g. "pay-to-be-safe (base + p75)". */
  savingBasis?: string;
  /** "feehistory" or "feehistory+mempool" (tips capped by the live mempool). */
  quoteBasis?: string;
  /** Median tip in the live pending block, in gwei; null when not measured. */
  mempoolTipP50Gwei?: number | null;
}

export interface Advice {
  waitMinutes: number;
  savePercent: number;
  estFutureMaxFee: number; // gwei
  confidence: number;
  generatedAt?: string;
  /** Whether the advised fee meets the requested targetSavingPct. */
  targetMet?: boolean;
  gasLimit?: number;
  /** Base fee now, in gwei. */
  currentFee?: number;
  /** Reference fee the saving is measured against, in gwei. */
  naiveFee?: number;
  /** The fee the advice recommends, in gwei. */
  advisedFee?: number;
  /** What the saving comes from, e.g. "tip+temporal". */
  basis?: string;
  chain?: Chain;
}

export interface AdvancedQuote {
  fee: number; // gwei
  unit: "gwei";
  confidenceRequested: number;
  confidenceAchieved: number;
  blocks: number;
  estSeconds: number;
  base_fee_gwei: number;
  source: string;
  snapshotAge: number;
  generatedAt?: string;
}

/** EIP-1559 fee parameters in wei, ready to merge into a transaction. */
export interface FeeParams {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** What produced these numbers — useful for logging and support. */
  source: {
    endpoint: "/v1/quick" | "/v1/advanced";
    profile?: FeeProfile;
    confidence?: number;
    blocks?: number;
    baseFeeGwei: number;
    tipGwei: number;
    baseFeeMultiplier: number;
  };
}

export type McfoErrorCode =
  | "feed_stale"
  | "invalid_api_key"
  | "rate_limited"
  | "invalid_param"
  | "http_error"
  | "network_error";

/** Typed error mapping the API's documented failure bodies. */
export class McfoError extends Error {
  readonly code: McfoErrorCode;
  readonly status?: number;
  /** Seconds to wait — set for rate_limited (T-A3) and feed_stale. */
  readonly retryAfterSeconds?: number;
  /** Offending parameter name — set for invalid_param (§12). */
  readonly param?: string;

  constructor(
    code: McfoErrorCode,
    message: string,
    extra: { status?: number; retryAfterSeconds?: number; param?: string } = {},
  ) {
    super(message);
    this.name = "McfoError";
    this.code = code;
    this.status = extra.status;
    this.retryAfterSeconds = extra.retryAfterSeconds;
    this.param = extra.param;
  }
}

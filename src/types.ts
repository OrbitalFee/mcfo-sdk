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

// ── Bitcoin (product-spec §16, T41) ──────────────────────────────────────────
//
// Every figure below is passed through from the API as served. The SDK never
// computes an odds figure: product-spec §16 records that the histogram the
// quote walks OVER-STATES inclusion, so the only defensible number is one
// that was measured against real blocks, with its date and sample attached.

/** `floored`: the whole queue clears below the relay floor, so the tiers collapse to it. */
export type BtcMarketState = "floored" | "contested" | "flat";

/** Which measured population the reliability figures describe (B58). */
export type BtcReliabilityBasis = "floored" | "aboveFloor" | "all";

export interface BtcTier {
  /** The rate served, after the tier's relay floor, in sat/vB. */
  satVb: number;
  /** The queue's own rate before the floor, in sat/vB. */
  rawSatVb: number;
  /** Virtual block the rate clears in the current queue; null in a floored market (B47). */
  blocks: number | null;
  /** Expectation over Poisson arrival; null whenever `blocks` is null. */
  etaMinutes: number | null;
  belowRelayFloor: boolean;
  /** The relay floor applied to this tier (T-B18). */
  floorSatVb?: number;
  /** USD for the requested vsize at the stored price; null without a fresh price. */
  usd: number | null;
  /** Measured share of quotes at this rate that made the very next block. Absent or null when unmeasured. */
  landsNextBlockPct?: number | null;
  landsWithin3BlocksPct?: number | null;
  landsWithin6BlocksPct?: number | null;
}

/** Weight at or above a fee rate — a vector by design, never a mempool total (§16). */
export interface BtcDepthRow {
  min_sat_vb: number;
  vsize: number;
  blocks: number;
}

/**
 * The measurement behind the odds: what the served quote achieved against the
 * next real block, with its window, sample and expiry (B46, B56, B58, B64).
 */
export interface BtcReliability {
  measuredOn: string;
  window?: string;
  spanDays?: number;
  quotesScored: number;
  blocksScored: number;
  basis: BtcReliabilityBasis;
  truth?: string;
  source?: string;
  servedLandsNextBlockPct: number;
  rawLandsNextBlockPct: number;
  providerLandsNextBlockPct: number;
  providerLandsWithin3BlocksPct?: number;
  providerLandsWithin6BlocksPct?: number;
  /** Median saving against mempool.space `fastestFee`; 0 in a floored market. */
  medianSavingVsProviderPct: number;
  horizonBlocks: number;
  /** "the next real block" — stated in words because it is the trap (§16). */
  horizon: string;
  ageDays: number;
  /** True past the 30-day expiry: the figures describe a market that may have moved. */
  stale: boolean;
  sharedByAllTiers: boolean;
  measuredTier?: string;
}

export interface BtcQuote {
  chain: "btc";
  tiers: { saver: BtcTier; balanced: BtcTier; priority: BtcTier };
  marketState: BtcMarketState;
  marginalSatVb: number;
  providerFastestSatVb?: number | null;
  overpayRatio?: number | null;
  depth: BtcDepthRow[];
  txCount?: number;
  source: string;
  vsizeAssumed: number;
  quoteBasis?: string;
  providerVblock0FloorSatVb?: number | null;
  /** The lowest floor served (T-B18). */
  relayFloorSatVb: number;
  tierFloorsSatVb?: { saver: number; balanced: number; priority: number };
  subRelayCaveat?: string | null;
  /** Absent or null when nothing was measured for this market state. */
  reliability?: BtcReliability | null;
  priceUsd?: number | null;
  priceSource?: string | null;
  priceTs?: number | string | null;
  snapshotAge: number;
  generatedAt: string;
}

export interface BtcProviderRow {
  provider: string;
  next_block_sat_vb: number | null;
  economy_sat_vb: number | null;
  note: string | null;
  vs_mcfo_ratio: number | null;
  overpay_pct: number | null;
}

export interface BtcProviders {
  chain: "btc";
  marginalSatVb: number | null;
  /** False when mempool.space is down: the other estimators are still listed. */
  queueAvailable: boolean;
  providers: BtcProviderRow[];
  snapshotAge: number;
  generatedAt: string;
}

export interface BtcHistoryPoint {
  /** Epoch seconds. */
  ts: number;
  marginalSatVb: number;
  providerFastestSatVb: number | null;
  providerEconomySatVb: number | null;
  overpayRatio: number | null;
}

/**
 * @orbitalfee/mcfo-sdk — MCFO fee selection for Ethereum transactions (T29).
 *
 * Two layers:
 *   1. `McfoClient` — typed access to /v1/quick, /v1/advice/save, /v1/advanced,
 *      plus `getFeeParams()` returning EIP-1559 values in wei; and, for
 *      Bitcoin (T41), /v1/btc/quick, /v1/btc/providers and /v1/btc/history
 *      with the measured next-block odds passed through as served.
 *   2. `sendTransaction()` — merges those fees into a transaction and delegates
 *      signing/submission to the caller's ethers Signer or viem WalletClient.
 *
 * The SDK never handles private keys.
 */
export { McfoClient, feeParamsFromQuote, gweiToWei } from "./client.js";
export type { McfoClientOptions } from "./client.js";
export { sendTransaction, isViemWalletClient } from "./send.js";
export type {
  EthersLikeSigner,
  SendOptions,
  SendResult,
  ViemLikeWalletClient,
  Wallet,
} from "./send.js";
export { McfoError } from "./types.js";
export type {
  Advice,
  AdvancedQuote,
  BtcDepthRow,
  BtcHistoryPoint,
  BtcMarketState,
  BtcProviderRow,
  BtcProviders,
  BtcQuote,
  BtcReliability,
  BtcReliabilityBasis,
  BtcTier,
  Chain,
  FeeParams,
  FeeProfile,
  FeeTier,
  McfoErrorCode,
  Quote,
} from "./types.js";

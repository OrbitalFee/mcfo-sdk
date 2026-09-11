/**
 * @orbitalfee/mcfo-sdk — MCFO fee selection for Ethereum transactions (T29).
 *
 * Two layers:
 *   1. `McfoClient` — typed access to /v1/quick, /v1/advice/save, /v1/advanced,
 *      plus `getFeeParams()` returning EIP-1559 values in wei.
 *   2. `sendTransaction()` — merges those fees into a transaction and delegates
 *      signing/submission to the caller's ethers Signer or viem WalletClient.
 *
 * The SDK never handles private keys.
 */
export { McfoClient, gweiToWei } from "./client.js";
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
  Chain,
  FeeParams,
  FeeProfile,
  FeeTier,
  McfoErrorCode,
  Quote,
} from "./types.js";

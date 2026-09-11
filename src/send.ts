/**
 * Transaction submission wrapper.
 *
 * The SDK never holds keys: it applies MCFO fee parameters and hands the
 * transaction to the caller's own ethers Signer or viem WalletClient, which
 * owns signing and submission. Wallet/key management is deliberately out of
 * scope (product-spec §1 defers it pending security + legal review; T30
 * owns it).
 */
import { McfoClient } from "./client.js";
import { Chain, FeeParams, FeeProfile } from "./types.js";

/** Minimal structural shape of an ethers v6 Signer we depend on. */
export interface EthersLikeSigner {
  sendTransaction(tx: Record<string, unknown>): Promise<{ hash: string }>;
}

/** Minimal structural shape of a viem WalletClient we depend on. */
export interface ViemLikeWalletClient {
  account?: unknown;
  transport?: unknown;
  sendTransaction(tx: Record<string, unknown>): Promise<string>;
}

export type Wallet = EthersLikeSigner | ViemLikeWalletClient;

export interface SendOptions {
  chain?: Chain;
  profile?: FeeProfile;
  confidence?: number;
  blocks?: number;
  baseFeeMultiplier?: number;
  /** Reuse already-fetched fees instead of calling the API again. */
  feeParams?: FeeParams;
}

export interface SendResult {
  hash: string;
  feeParams: FeeParams;
  /** The client's own return value (ethers TransactionResponse / viem hash). */
  raw: unknown;
}

/** viem clients carry a transport and an account; ethers signers do not. */
export function isViemWalletClient(wallet: Wallet): wallet is ViemLikeWalletClient {
  return (
    typeof (wallet as ViemLikeWalletClient).sendTransaction === "function" &&
    "transport" in (wallet as object) &&
    "account" in (wallet as object)
  );
}

/**
 * Send `tx` with MCFO-selected fees.
 *
 * Fees the caller set explicitly are preserved — the SDK only fills gaps, so
 * an override always wins.
 */
export async function sendTransaction(
  client: McfoClient,
  wallet: Wallet,
  tx: Record<string, unknown>,
  options: SendOptions = {},
): Promise<SendResult> {
  const feeParams =
    options.feeParams ??
    (await client.getFeeParams({
      chain: options.chain,
      profile: options.profile,
      confidence: options.confidence,
      blocks: options.blocks,
      baseFeeMultiplier: options.baseFeeMultiplier,
    }));

  const withFees: Record<string, unknown> = {
    ...tx,
    maxFeePerGas: tx.maxFeePerGas ?? feeParams.maxFeePerGas,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? feeParams.maxPriorityFeePerGas,
  };

  if (isViemWalletClient(wallet)) {
    const hash = await wallet.sendTransaction(withFees);
    return { hash, feeParams, raw: hash };
  }
  const response = await (wallet as EthersLikeSigner).sendTransaction(withFees);
  return { hash: response.hash, feeParams, raw: response };
}

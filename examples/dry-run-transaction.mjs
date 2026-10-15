// Price a transaction with Orbital Fee and hand it to a wallet, without
// sending anything: the "wallet" here only records what it was given.
//
//   npm run build && node examples/dry-run-transaction.mjs
//
// With a real wallet, pass your ethers Signer or viem WalletClient instead of
// `recorder`. The SDK never sees a private key: your wallet signs and sends.
import { McfoClient, sendTransaction } from "@orbitalfee/mcfo-sdk";

const accessHeaders =
  process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET
    ? {
        "CF-Access-Client-Id": process.env.CF_ACCESS_CLIENT_ID,
        "CF-Access-Client-Secret": process.env.CF_ACCESS_CLIENT_SECRET,
      }
    : undefined;
const mcfo = new McfoClient({ headers: accessHeaders });

// Same shape as an ethers v6 Signer: sendTransaction(tx) -> { hash }.
const recorder = {
  sent: [],
  async sendTransaction(tx) {
    this.sent.push(tx);
    return { hash: "0x(dry-run, not sent)" };
  },
};

const tx = { to: "0x000000000000000000000000000000000000dEaD", value: 10n ** 15n, gasLimit: 21000n };

// 1. Confidence-targeted: 90% chance of inclusion within 3 blocks.
const a = await sendTransaction(mcfo, recorder, tx, { confidence: 0.9, blocks: 3 });
// 2. A fee you set yourself always wins; the SDK only fills the gap.
const b = await sendTransaction(mcfo, recorder, { ...tx, maxPriorityFeePerGas: 1n }, { profile: "saver" });

for (const [label, result, sent] of [["confidence 0.9 / 3 blocks", a, recorder.sent[0]],
                                     ["saver, tip set by caller", b, recorder.sent[1]]]) {
  console.log(`\n${label}  (${result.feeParams.source.endpoint}, hash ${result.hash})`);
  console.log(`  maxFeePerGas         ${sent.maxFeePerGas} wei`);
  console.log(`  maxPriorityFeePerGas ${sent.maxPriorityFeePerGas} wei`);
}

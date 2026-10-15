// Print the three fee profiles from the live API, in gwei and in wei.
//
//   npm run build && node examples/quick-fees.mjs
//
// Inside this repository "@orbitalfee/mcfo-sdk" resolves to ./dist (package
// self-reference), so the file runs unchanged in your own project after
// `npm install @orbitalfee/mcfo-sdk`.
import { McfoClient, McfoError } from "@orbitalfee/mcfo-sdk";

const accessHeaders =
  process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET
    ? {
        "CF-Access-Client-Id": process.env.CF_ACCESS_CLIENT_ID,
        "CF-Access-Client-Secret": process.env.CF_ACCESS_CLIENT_SECRET,
      }
    : undefined;
const mcfo = new McfoClient({ apiKey: process.env.MCFO_API_KEY, headers: accessHeaders }); // no key = free tier

try {
  const quote = await mcfo.getQuote();
  console.log(`Base fee ${quote.base_fee_gwei} gwei (snapshot ${quote.snapshotAge} s old)\n`);
  for (const profile of ["saver", "balanced", "priority"]) {
    const fees = await mcfo.getFeeParams({ profile });
    console.log(
      `${profile.padEnd(9)} tip ${fees.source.tipGwei.toFixed(4)} gwei` +
        `  maxPriorityFeePerGas ${fees.maxPriorityFeePerGas}` +
        `  maxFeePerGas ${fees.maxFeePerGas}`,
    );
  }
} catch (err) {
  if (err instanceof McfoError) {
    console.error(`Orbital Fee API: ${err.code}` +
      (err.retryAfterSeconds ? `, retry in ${err.retryAfterSeconds} s` : ""));
    process.exitCode = 1;
  } else {
    throw err;
  }
}

// Package test: what `npm install @orbitalfee/mcfo-sdk` actually delivers.
// Packs the tarball, installs it into a throwaway project, imports it by its
// published name and type-checks a TypeScript consumer against the shipped
// .d.ts files. Catches a broken "exports" map, a missing file in "files", or
// types that do not compile for a user, none of which the unit tests can see.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const TSC = join(ROOT, "node_modules", "typescript", "bin", "tsc");

let dir;
let tarball;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "mcfo-sdk-pkg-"));
  const out = execFileSync(NPM, ["pack", "--json", "--pack-destination", dir], {
    cwd: ROOT,
    encoding: "utf8",
  });
  tarball = JSON.parse(out)[0];
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module" }),
  );
  execFileSync(NPM, ["install", "--no-audit", "--no-fund", join(dir, tarball.filename)], {
    cwd: dir,
    stdio: "ignore",
  });
});

after(() => rmSync(dir, { recursive: true, force: true }));

test("the tarball ships the build, the types, the README and the licence, and nothing else", () => {
  const files = tarball.files.map((f) => f.path).sort();
  for (const want of ["LICENSE", "README.md", "dist/index.js", "dist/index.d.ts", "package.json"]) {
    assert.ok(files.includes(want), `missing ${want}`);
  }
  assert.ok(!files.some((f) => f.startsWith("src/") || f.startsWith("test/")), files.join(", "));
});

test("the installed package imports by name and exposes the public API", async () => {
  const run = (code) =>
    execFileSync(process.execPath, ["--input-type=module", "-e", code], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
  const exported = run(
    'import * as m from "@orbitalfee/mcfo-sdk"; console.log(Object.keys(m).sort().join(","))',
  );
  assert.equal(exported, "McfoClient,McfoError,feeParamsFromQuote,gweiToWei,isViemWalletClient,sendTransaction");
  assert.equal(
    run('import { gweiToWei } from "@orbitalfee/mcfo-sdk"; console.log(String(gweiToWei(0.1141)))'),
    "114100000",
  );
});

test("a TypeScript consumer type-checks against the shipped declarations", () => {
  writeFileSync(
    join(dir, "consumer.ts"),
    `import { McfoClient, McfoError, sendTransaction } from "@orbitalfee/mcfo-sdk";
import type { FeeParams, FeeProfile, Quote, Advice } from "@orbitalfee/mcfo-sdk";

const client = new McfoClient({ apiKey: "mcfo_example", timeoutMs: 3000 });
const profile: FeeProfile = "saver";
async function main(): Promise<bigint> {
  const fees: FeeParams = await client.getFeeParams({ profile });
  const quote: Quote = await client.getQuote();
  const advice: Advice = await client.getAdvice({ gasLimit: 150000 });
  const saving: number | undefined = quote.slow.savingPct;
  const advised: number | undefined = advice.advisedFee;
  void saving; void advised;
  const signer = { sendTransaction: async (_tx: Record<string, unknown>) => ({ hash: "0x" }) };
  const sent = await sendTransaction(client, signer, { to: "0x0" }, { feeParams: fees });
  void sent.hash;
  return fees.maxFeePerGas;
}
main().catch((e: unknown) => {
  if (e instanceof McfoError) console.log(e.code, e.retryAfterSeconds);
});
`,
  );
  // Not in the sorted export list above: types only. This is the line a user
  // with a typo or a removed type would trip over.
  execFileSync(
    process.execPath,
    [TSC, "--noEmit", "--strict", "--module", "NodeNext", "--moduleResolution", "NodeNext",
      "--target", "ES2022", "--lib", "ES2022,DOM", "consumer.ts"],
    { cwd: dir, encoding: "utf8" },
  );
  assert.ok(readdirSync(dir).includes("consumer.ts"));
});

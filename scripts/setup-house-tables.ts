// One-off: create the house tables (deployer pays base rent, ~0.0315 SOL each) and normalise
// every house table's trading window with `set_window` (creator-only, ER, free).
//
//   npx tsx scripts/setup-house-tables.ts --create N --window SECS [existing tables...]
//
// Refuses to create a table if the deployer would drop below 0.25 SOL, and never creates more
// than 4 house tables in total (existing + new). Prints the addresses for web/src/config.ts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { OutcryClient, explainError } from "../client/src/index.js";
import { BASE_RPC, PROGRAM_ID, TEE_RPC } from "../web/src/config.js";

const TABLE_COST = 0.0315 * LAMPORTS_PER_SOL;
const FLOOR = 0.25 * LAMPORTS_PER_SOL;
const MAX_TABLES = 4;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const create = Number(arg("create") ?? 0);
  const windowSecs = Number(arg("window") ?? 60);
  const existing = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--"));
  const deployer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/outcry-devnet/deployer.json"), "utf8"))),
  );
  const base = new Connection(BASE_RPC, "confirmed");
  const client = new OutcryClient({ base, teeRpc: TEE_RPC, programId: new PublicKey(PROGRAM_ID) });
  const er = client.er(await client.authKeypair(deployer));
  if (existing.length + create > MAX_TABLES) throw new Error(`at most ${MAX_TABLES} house tables`);

  const tables = existing.map((a) => new PublicKey(a));
  for (let k = 0; k < create; k++) {
    const bal = await base.getBalance(deployer.publicKey);
    if (bal - TABLE_COST < FLOOR) {
      console.log(`stop: deployer has ${bal / LAMPORTS_PER_SOL} SOL; another table would drop it below 0.25 SOL`);
      break;
    }
    const tableId = BigInt(Date.now());
    const r = await client.createAndDelegateTable(deployer, tableId, windowSecs, er);
    console.log(`created table ${r.table.toBase58()} id ${tableId} window ${windowSecs}s`);
    for (const [k2, v] of Object.entries(r.signatures)) console.log(`  ${k2} ${v}`);
    tables.push(r.table);
  }

  for (const t of tables) {
    const state = await client.fetchTable(er, t);
    if (state.windowSecs === windowSecs) {
      console.log(`${t.toBase58()} window already ${windowSecs}s (phase ${state.phase}, round ${state.round})`);
      continue;
    }
    try {
      const sig = await client.sendEr(er, [await client.setWindowIx(deployer.publicKey, t, windowSecs)], [deployer]);
      console.log(`${t.toBase58()} set_window ${state.windowSecs}s -> ${windowSecs}s ${sig}`);
    } catch (e) {
      console.log(`${t.toBase58()} set_window failed: ${explainError(e).short} (phase ${state.phase})`);
    }
  }
  console.log(`deployer balance ${(await base.getBalance(deployer.publicKey)) / LAMPORTS_PER_SOL} SOL`);
  console.log("tables:", tables.map((t) => t.toBase58()).join(","));
}

main().catch((e) => {
  console.error(explainError(e).detail);
  process.exit(1);
});

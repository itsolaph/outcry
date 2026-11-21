// Prints the base-layer lamports locked by one table: table, seats, and their delegation PDAs.
//   npx tsx scripts/inspect-costs.ts <table pubkey>
import { Connection, PublicKey } from "@solana/web3.js";
import {
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { seatPdas } from "../client/src/index.js";

const conn = new Connection(process.env.BASE_RPC ?? "https://api.devnet.solana.com", "confirmed");
const table = new PublicKey(process.argv[2]);
let total = 0;
for (const [name, acct] of [["table", table] as const, ...seatPdas(table).map((s, i) => [`seat${i}`, s] as const)]) {
  for (const [kind, key] of [
    ["account", acct],
    ["delegation record", delegationRecordPdaFromDelegatedAccount(acct)],
    ["delegation metadata", delegationMetadataPdaFromDelegatedAccount(acct)],
  ] as const) {
    const info = await conn.getAccountInfo(key);
    total += info?.lamports ?? 0;
    console.log(`${name.padEnd(6)} ${kind.padEnd(20)} ${String(info?.lamports ?? 0).padStart(10)} lamports  ${info?.data.length ?? 0} bytes`);
  }
}
console.log(`total locked on base: ${total} lamports`);

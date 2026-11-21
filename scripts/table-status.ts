// Prints the public state of one or more delegated tables, read from the TEE ER without a token.
//   npx tsx scripts/table-status.ts <table> [<table> ...]
import { Connection, PublicKey } from "@solana/web3.js";
import { OutcryClient } from "../client/src/index.js";

const BASE_RPC = process.env.BASE_RPC ?? "https://api.devnet.solana.com";
const TEE_RPC = process.env.TEE_RPC ?? "https://devnet-tee.magicblock.app";

async function main() {
  const client = new OutcryClient({ base: new Connection(BASE_RPC, "confirmed"), teeRpc: TEE_RPC });
  const er = client.er();
  const slot = await er.getSlot();
  const erNow = (await er.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
  console.log(`ER slot ${slot}, ER unix ${erNow}, local unix ${Math.floor(Date.now() / 1000)}`);
  for (const a of process.argv.slice(2)) {
    const table = new PublicKey(a);
    try {
      const t = await client.fetchTable(er, table);
      const seats = t.seats.map((s, i) => `${i}:${s.kind}${s.kind === "human" ? "(" + s.owner.toBase58().slice(0, 6) + ")" : ""}`).join(" ");
      console.log(
        `${a} creator ${t.creator.toBase58().slice(0, 6)} id ${t.tableId} phase ${t.phase} round ${t.round} window ${t.windowSecs}s ` +
          `tradeEnd ${t.tradeEndTs} (${t.tradeEndTs ? erNow - t.tradeEndTs : "-"}s ago) dealReq ${t.dealRequestedTs} trades ${t.tradeCount} ` +
          `ticks ${t.tickCount} records ${t.recordsRound} seats ${seats}`,
      );
    } catch (e) {
      console.log(`${a} ERROR ${(e as Error).message}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

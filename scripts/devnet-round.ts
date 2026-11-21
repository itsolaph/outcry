// Plays one complete Outcry round on devnet: a scripted human (fresh 0-SOL keypair) against
// three on-chain bots driven by the TEE crank. Prints every signature, proves the human cannot
// read a bot hand during the round and can after the bell, and prints the scoreboard.
//
//   npx tsx scripts/devnet-round.ts [window_secs] [extended]
// `extended` additionally plays round 2 on the same delegated table (crank again, second record
// update) and then undelegates the table, checking base ownership.
// Env: DEPLOYER (keypair path, pays base-layer setup), WINDOW_SECS (default 90; the CLI
//      argument wins), BASE_RPC, TEE_RPC.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  OutcryClient,
  SIDE_ASK,
  SIDE_BID,
  SUITS,
  SeatState,
  TableState,
  VRF_PROGRAM_ID,
  orderFilled,
  orderRequirement,
  recordPda,
} from "../client/src/index.js";

const BASE_RPC = process.env.BASE_RPC ?? "https://api.devnet.solana.com";
const TEE_RPC = process.env.TEE_RPC ?? "https://devnet-tee.magicblock.app";
const WINDOW_SECS = Number(process.argv[2] ?? process.env.WINDOW_SECS ?? 90);
/** `extended`: also play round 2 on the same table, then undelegate it. */
const EXTENDED = process.argv[3] === "extended";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...a);
const short = (k: PublicKey) => k.toBase58().slice(0, 6);
const errMsg = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0].slice(0, 200);

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function fmtHand(s: SeatState): string {
  return s.hand.map((n, i) => `${SUITS[i][0].toUpperCase()}${n}`).join(" ");
}
function fmtOrder(s: SeatState): string {
  const o = s.order;
  return `${o.qtyA}x${SUITS[o.suitA]} + ${o.qtyB}x${SUITS[o.suitB]}`;
}

async function main() {
  const deployer = loadKeypair(
    process.env.DEPLOYER ?? path.join(os.homedir(), ".config/solana/outcry-devnet/deployer.json"),
  );
  const base = new Connection(BASE_RPC, "confirmed");
  const client = new OutcryClient({ base, teeRpc: TEE_RPC });
  const human = Keypair.generate(); // session key and record wallet; never funded
  log("program", client.programId.toBase58());
  const startBal = await base.getBalance(deployer.publicKey);
  log("creator/deployer", deployer.publicKey.toBase58(), `${startBal / 1e9} SOL`);
  log("human (0 SOL)", human.publicKey.toBase58(), "balance", await base.getBalance(human.publicKey));

  // ---- one-time setup: table + seats on base, delegated to the TEE, permissions on the ER
  const tableId = BigInt(Date.now());
  const deployerTok = await client.authKeypair(deployer);
  const erCreator = client.er(deployerTok);
  const setup = await client.createAndDelegateTable(deployer, tableId, WINDOW_SECS, erCreator);
  const table = setup.table;
  log("table", table.toBase58(), "id", tableId.toString());
  log("tx create_table (base)", setup.signatures.create);
  log("tx delegate table+seat0 (base)", setup.signatures.delegate1);
  log("tx delegate seats 1-3 (base)", setup.signatures.delegate2);
  log("tx init_permissions (ER)", setup.signatures.perms);

  const recSig = await client.sendBase([await client.initRecordIx(deployer.publicKey, human.publicKey)], [deployer]);
  log("tx init_record for the human's wallet (base)", recSig);

  // ---- human: authenticate, join seat 0 bound to its wallet, start the round with the crank
  const humanTok = await client.authKeypair(human);
  const er = client.er(humanTok);
  const anon = client.er();
  const joinSig = await client.sendEr(er, [await client.joinIx(human.publicKey, table, 0, human.publicKey)], [human]);
  log("tx join seat 0 (ER, 0-SOL signer)", joinSig);

  const unsub = client.subscribeTable(er, table, () => {});
  const startSig = await client.sendEr(er, [await client.startRoundIx(human.publicKey, table, true)], [human], 1_000_000);
  log("tx start_round + VRF request + crank schedule (ER)", startSig);

  // ---- wait for the VRF callback to deal
  let t: TableState = await client.fetchTable(er, table);
  let retried = false;
  const dealStart = Date.now();
  while (t.phase !== "trading") {
    await sleep(1000);
    t = await client.fetchTable(er, table);
    if (t.phase === "dealing" && !retried && Date.now() - dealStart > 25_000) {
      retried = true;
      // Same round, so the crank scheduled by the first call (task id = f(table, round)) is
      // still live: re-request VRF only.
      const s = await client.sendEr(er, [await client.startRoundIx(human.publicKey, table, false)], [human], 1_000_000);
      log("tx start_round retry (VRF callback late)", s);
    }
    if (Date.now() - dealStart > 90_000) throw new Error("VRF callback never dealt the round");
  }
  log(`VRF callback dealt round ${t.round} after ${((Date.now() - dealStart) / 1000).toFixed(1)}s; trading ends at unix ${t.tradeEndTs}`);

  // ---- privacy during the round
  const mine = await client.fetchMySeat(er, table, 0);
  log(`human seat 0 (own token): hand ${fmtHand(mine)} chips ${mine.chips} order ${fmtOrder(mine)}`);
  const botDuring = await client.readSeat(er, table, 1);
  log(`PRIVACY during round: human token reading bot seat 1 -> ${botDuring.visible ? "VISIBLE (unexpected!)" : `DENIED (${botDuring.reason})`}`);
  const anonDuring = await client.readSeat(anon, table, 0);
  log(`PRIVACY during round: no-token read of seat 0 -> ${anonDuring.visible ? "VISIBLE (unexpected!)" : "DENIED"}`);
  if (botDuring.visible || anonDuring.visible) throw new Error("privacy check failed");

  // The deal is a pure function of the VRF output in the callback's instruction data, so the
  // deal transaction must be redacted for every viewer while the seats are private.
  for (const [who, conn] of [["human token", er], ["no token", anon]] as const) {
    let listed = 0;
    let readable = 0;
    let dealVisible = false;
    try {
      const sigs = await conn.getSignaturesForAddress(table, { limit: 25 });
      listed = sigs.length;
      for (const s of sigs) {
        const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null);
        const keys = tx?.transaction.message.staticAccountKeys ?? [];
        const logs = tx?.meta?.logMessages ?? [];
        if (keys.length > 0 || logs.length > 0) readable++;
        if (logs.some((l) => l.includes("Instruction: Deal")) || keys.some((k) => k.equals(VRF_PROGRAM_ID))) {
          dealVisible = true;
        }
      }
    } catch (e) {
      log(`PRIVACY tx scan (${who}) RPC error: ${errMsg(e)}`);
    }
    log(`PRIVACY during round: ${who} lists ${listed} table txs, ${readable} with readable message/logs, deal tx ${dealVisible ? "VISIBLE (leak!)" : "redacted/absent"}`);
    if (dealVisible) throw new Error(`deal transaction readable with ${who}`);
  }

  // ---- trading: the human chases its order; the crank drives the bots and rings the bell
  const humanSigs: string[] = [];
  let lastTick = t.tickCount;
  let lastTickChange = Date.now();
  let manualTicks = 0;
  while (true) {
    await sleep(2500);
    t = await client.fetchTable(er, table);
    if (t.phase !== "trading") break;
    if (t.tickCount !== lastTick) {
      lastTick = t.tickCount;
      lastTickChange = Date.now();
    } else if (Date.now() - lastTickChange > 6000) {
      // Crank fallback: the tick is permissionless.
      try {
        const s = await client.sendEr(er, [await client.botTickIx(table)], [human]);
        manualTicks++;
        log("tx bot_tick (manual fallback, crank stalled)", s);
      } catch (e) {
        log("manual bot_tick failed", errMsg(e));
      }
    }
    const now = Math.floor(Date.now() / 1000);
    if (now >= t.tradeEndTs - 2) continue;
    let me: SeatState;
    try {
      me = await client.fetchMySeat(er, table, 0);
    } catch {
      continue;
    }
    const need = orderRequirement(me.order).map((r, s) => r - me.hand[s]);
    // 1. Lift the cheapest offer in a suit still needed.
    let best: { price: number; suit: number; seat: number } | null = null;
    for (let s = 0; s < 4; s++) {
      if (need[s] <= 0) continue;
      for (let seat = 1; seat < 4; seat++) {
        const p = t.asks[s][seat];
        if (p && p <= 45 && p <= me.chips && (!best || p < best.price)) best = { price: p, suit: s, seat };
      }
    }
    try {
      if (best) {
        const s = await client.sendEr(er, [await client.takeIx(human.publicKey, table, 0, best.suit, SIDE_ASK, best.seat)], [human]);
        humanSigs.push(s);
        log(`tx take: human buys 1 ${SUITS[best.suit]} @${best.price} from seat ${best.seat}`, s);
        continue;
      }
      // 2. Sell surplus into a decent bid.
      let bid: { price: number; suit: number; seat: number } | null = null;
      for (let s = 0; s < 4; s++) {
        if (need[s] >= 0) continue;
        for (let seat = 1; seat < 4; seat++) {
          const p = t.bids[s][seat];
          if (p && p >= 8 && (!bid || p > bid.price)) bid = { price: p, suit: s, seat };
        }
      }
      if (bid) {
        const s = await client.sendEr(er, [await client.takeIx(human.publicKey, table, 0, bid.suit, SIDE_BID, bid.seat)], [human]);
        humanSigs.push(s);
        log(`tx take: human sells 1 ${SUITS[bid.suit]} @${bid.price} to seat ${bid.seat}`, s);
        continue;
      }
      // 3. Otherwise rest a bid in the most needed suit.
      const s = need.indexOf(Math.max(...need));
      if (need[s] > 0 && t.bids[s][0] === 0 && me.chips >= 30) {
        const sig = await client.sendEr(er, [await client.quoteIx(human.publicKey, table, 0, s, SIDE_BID, 30)], [human]);
        humanSigs.push(sig);
        log(`tx quote: human bids 30 for ${SUITS[s]}`, sig);
      }
    } catch (e) {
      log("human action rejected (book moved):", errMsg(e));
    }
  }

  // ---- bell (normally rung by the crank)
  const bellWait = Date.now();
  while (t.phase !== "settled") {
    if (Date.now() - bellWait > 15_000) {
      const s = await client.sendEr(er, [await client.ringBellIx(table)], [human]);
      log("tx ring_bell (manual fallback)", s);
    }
    await sleep(1500);
    t = await client.fetchTable(er, table);
  }
  log(`bell rung: phase ${t.phase}, ticks ${t.tickCount} (manual fallbacks: ${manualTicks}), trades ${t.tradeCount}`);
  await sleep(1500);

  // ---- reveal
  const botAfter = await client.readSeat(er, table, 1);
  log(`PRIVACY after bell: human token reading bot seat 1 -> ${botAfter.visible ? "VISIBLE (revealed)" : `DENIED (${botAfter.reason})`}`);
  if (!botAfter.visible) throw new Error("reveal check failed");
  const revealed = await client.fetchRevealedSeats(anon, table);

  console.log("\nTAPE (oldest first)");
  for (const p of t.tape) {
    console.log(`  ${new Date(p.unixTs * 1000).toISOString().slice(11, 19)}  ${SUITS[p.suit].padEnd(8)} @${String(p.price).padStart(2)}  seat${p.seller} -> seat${p.buyer}`);
  }
  console.log("\nFINAL SCOREBOARD (round " + t.round + ")");
  const order = [0, 1, 2, 3].sort((a, b) => t.ranks[a] - t.ranks[b]);
  for (const i of order) {
    const r = revealed[i];
    const who = t.seats[i].kind === "human" ? `human ${short(t.seats[i].owner)}` : "bot";
    if (!r.visible) {
      console.log(`  #${t.ranks[i] + 1} seat ${i} ${who}: hidden?!`);
      continue;
    }
    const s = r.value;
    console.log(
      `  #${t.ranks[i] + 1}  seat ${i} ${who.padEnd(13)} score ${String(t.scores[i]).padStart(3)} = ${s.chips} chips + ${t.filled[i] ? 100 : 0}  hand ${fmtHand(s)}  order ${fmtOrder(s)} ${orderFilled(s) ? "FILLED" : "missed"}`,
    );
  }
  console.log("");

  // ---- lifetime record through a standalone Magic Action
  const pubSig = await client.sendEr(er, [await client.publishRecordsIx(human.publicKey, table)], [human]);
  log("tx publish_records (ER, schedules base-layer Magic Action)", pubSig);
  let rec = null;
  for (let i = 0; i < 40; i++) {
    rec = await client.fetchRecord(human.publicKey);
    if (rec && rec.rounds > 0) break;
    await sleep(1500);
  }
  if (rec && rec.rounds > 0) {
    log(`base PlayerRecord updated: rounds ${rec.rounds}, wins ${rec.wins}, orders filled ${rec.ordersFilled}, best ${rec.bestScore}, last round ${rec.lastRound}`);
    const recSigs = await base.getSignaturesForAddress(recordPda(human.publicKey, client.programId), { limit: 3 }).catch(() => []);
    for (const s of recSigs) log("  base tx touching the record:", s.signature);
  } else {
    log("base PlayerRecord NOT updated within 60 s (Magic Action not observed)");
  }
  if (EXTENDED) {
    // ---- round 2 on the same delegated table, crank again, then retire the table
    const s2 = await client.sendEr(er, [await client.startRoundIx(human.publicKey, table, true)], [human], 1_000_000);
    log("ROUND 2: tx start_round + VRF + crank (same table, no re-delegation)", s2);
    const d2 = Date.now();
    do {
      await sleep(1000);
      t = await client.fetchTable(er, table);
      if (Date.now() - d2 > 60_000) throw new Error("round 2 VRF callback never dealt");
    } while (t.phase !== "trading" || t.round !== 2);
    log(`ROUND 2: dealt round ${t.round}; trading ends at unix ${t.tradeEndTs}`);
    const bot2 = await client.readSeat(er, table, 1);
    log(`ROUND 2 PRIVACY: human token reading bot seat 1 -> ${bot2.visible ? "VISIBLE (unexpected!)" : "DENIED"}`);
    if (bot2.visible) throw new Error("round 2 privacy check failed");
    const tradesAt = t.tradeCount;
    const b2 = Date.now();
    while (t.phase !== "settled") {
      await sleep(2000);
      t = await client.fetchTable(er, table);
      if (Date.now() - b2 > (WINDOW_SECS + 40) * 1000) throw new Error("round 2 bell never rang");
    }
    log(`ROUND 2: bell rung by the crank, ticks ${t.tickCount}, ${t.tradeCount - tradesAt} bot trades, scores ${t.scores.join("/")}, ranks ${t.ranks.join("/")}`);
    await sleep(1500);
    const bot2After = await client.readSeat(er, table, 1);
    log(`ROUND 2 PRIVACY after bell: bot seat 1 -> ${bot2After.visible ? "VISIBLE (revealed)" : "DENIED"}`);
    if (!bot2After.visible) throw new Error("round 2 reveal failed");
    const pub2 = await client.sendEr(er, [await client.publishRecordsIx(human.publicKey, table)], [human]);
    log("ROUND 2: tx publish_records", pub2);
    let rec2 = null;
    for (let i = 0; i < 40; i++) {
      rec2 = await client.fetchRecord(human.publicKey);
      if (rec2 && rec2.rounds >= 2) break;
      await sleep(1500);
    }
    log(`ROUND 2: base PlayerRecord rounds ${rec2?.rounds}, wins ${rec2?.wins}, filled ${rec2?.ordersFilled}, best ${rec2?.bestScore}, last round ${rec2?.lastRound}`);
    if (!rec2 || rec2.rounds < 2) throw new Error("round 2 record not updated");

    // ---- retire: close permissions, commit + undelegate table and seats
    const und = await client.sendEr(erCreator, [await client.undelegateTableIx(deployer.publicKey, table)], [deployer], 600_000);
    log("tx undelegate_table (ER, creator)", und);
    const u0 = Date.now();
    for (;;) {
      const owners = await Promise.all([table, ...client.seats(table)].map((k) => base.getAccountInfo(k).then((i) => i?.owner)));
      if (owners.every((o) => o?.equals(client.programId))) break;
      if (Date.now() - u0 > 90_000) throw new Error(`undelegation not observed on base: ${owners.map((o) => o?.toBase58()).join(",")}`);
      await sleep(2000);
    }
    const baseTable = await client.fetchTable(base, table);
    log(`UNDELEGATED after ${((Date.now() - u0) / 1000).toFixed(1)}s: table + 4 seats owned by the program on base; base table round ${baseTable.round}, phase ${baseTable.phase}, trades ${baseTable.tradeCount}`);
  }

  await unsub();
  const endBal = await base.getBalance(deployer.publicKey);
  log(`deployer spent ${startBal - endBal} lamports on base (one-time table setup + record init); human balance ${await base.getBalance(human.publicKey)}`);
  log(`human signed ${humanSigs.length} trading transactions; done.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

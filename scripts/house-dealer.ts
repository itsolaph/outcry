// House dealer: keeps the public house tables moving so the lobby always shows live rounds.
//
//   npx tsx scripts/house-dealer.ts [--rounds N] [--gap SECS] [--minutes M] [--tables a,b,...]
//                                   [--stagger SECS] [--creator-fallback]
//
// For each house table (web/src/config.ts, or --tables):
// - between rounds, once the last round has been settled for more than --gap seconds (default 25)
//   and no newly seated human is inside the 20 s grace, the dealer's own key joins a free bot
//   seat and starts the next round with the crank in one ER transaction (`start_round` needs a
//   seated signer or the table creator), then gives the seat back to the house bot with `leave`
//   as soon as trading opens. Bots-only rounds are fine;
// - after each bell it calls `publish_records` (once per round);
// - a round stuck in `dealing` past the program's 20 s retry is re-requested (`start_round` with
//   `use_crank = false`, the first crank is still scheduled);
// - if the crank's bell is late it rings the bell itself.
// Every transaction is an ER transaction signed by a 0-SOL key, so a round costs 0 lamports.
// The dealer key is generated on first run and stored under ~/.config/solana/outcry-devnet/
// (never in the repo). `--creator-fallback` additionally lets the table creator key (deployer,
// ER transactions only) restart a round when no seated signer exists (all seats held by humans,
// or a human who started a round vanished while it was stuck in `dealing`).
// Stops after every table has completed N rounds started by this dealer (--rounds), after M
// minutes (--minutes), or on Ctrl-C (leaves any seat it holds first).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { OutcryClient, TableState, explainError, freeSeats } from "../client/src/index.js";
import { BASE_RPC, HOUSE_TABLES, HUMAN_GRACE_SECS, PROGRAM_ID, TEE_RPC } from "../web/src/config.js";

const KEY_DIR = path.join(os.homedir(), ".config/solana/outcry-devnet");
const DEAL_RETRY_SECS = 20; // program constant
const POLL_MS = 2000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const ROUNDS = Number(arg("rounds") ?? 0); // 0 = run forever
const GAP = Number(arg("gap") ?? 25);
const MINUTES = Number(arg("minutes") ?? 0);
const STAGGER = Number(arg("stagger") ?? 15);
const CREATOR_FALLBACK = process.argv.includes("--creator-fallback");
const TABLES: { name: string; address: string }[] = arg("tables")
  ? arg("tables")!.split(",").map((a) => ({ name: a.slice(0, 4), address: a }))
  : HOUSE_TABLES;

const log = (table: string, msg: string) => console.log(`${new Date().toISOString()} [${table}] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loadOrCreateKey(file: string): Keypair {
  const p = path.join(KEY_DIR, file);
  if (fs.existsSync(p)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
  const kp = Keypair.generate();
  fs.writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  console.log(`generated ${file} (${kp.publicKey.toBase58()}) in the devnet key directory`);
  return kp;
}

interface TableRun {
  name: string;
  table: PublicKey;
  /** first time each (seat, owner) human was seen */
  firstSeen: Map<string, number>;
  /** rounds this dealer started (round numbers) */
  started: Set<number>;
  /** rounds started by the dealer that reached the bell and were published */
  completed: Set<number>;
  notBefore: number;
  lastNote: string;
  lastFail: number;
}

async function main() {
  if (TABLES.length === 0) throw new Error("no house tables configured (web/src/config.ts HOUSE_TABLES or --tables)");
  const dealer = loadOrCreateKey("house-dealer.json");
  const creatorPath = path.join(KEY_DIR, "deployer.json");
  const creator =
    CREATOR_FALLBACK && fs.existsSync(creatorPath)
      ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(creatorPath, "utf8"))))
      : null;
  const client = new OutcryClient({ base: new Connection(BASE_RPC, "confirmed"), teeRpc: TEE_RPC, programId: new PublicKey(PROGRAM_ID) });
  // The TEE token gates sends (and private reads). Re-authenticate before it expires and after
  // repeated read failures, so a long-running dealer never stalls on a stale token.
  let token = await client.authKeypair(dealer);
  let er = client.er(token);
  let readFailures = 0;
  const reauth = async (why: string) => {
    try {
      token = await client.authKeypair(dealer);
      er = client.er(token);
      readFailures = 0;
      console.log(`${new Date().toISOString()} re-authenticated to the TEE (${why}); token valid until ${new Date(token.expiresAt).toISOString()}`);
    } catch (e) {
      console.log(`${new Date().toISOString()} TEE re-authentication failed: ${explainError(e).short}`);
    }
  };
  const creatorEr = creator ? client.er(await client.authKeypair(creator)) : null;
  const me = dealer.publicKey.toBase58();
  console.log(
    `house dealer ${me} (0 SOL, ER only), ${TABLES.length} tables, gap ${GAP}s, grace ${HUMAN_GRACE_SECS}s, ` +
      `rounds ${ROUNDS || "unlimited"}${MINUTES ? `, ${MINUTES} min max` : ""}${creator ? ", creator fallback on" : ""}; ` +
      `TEE token valid until ${new Date(token.expiresAt).toISOString()}`,
  );

  const now0 = Date.now() / 1000;
  const runs: TableRun[] = TABLES.map((t, i) => ({
    name: t.name,
    table: new PublicKey(t.address),
    firstSeen: new Map(),
    started: new Set(),
    completed: new Set(),
    notBefore: now0 + i * STAGGER,
    lastNote: "",
    lastFail: 0,
  }));

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const deadline = MINUTES ? Date.now() + MINUTES * 60_000 : Infinity;

  let clockOffset = 0; // ER unix - local unix
  let clockAt = 0;
  const erNow = () => Date.now() / 1000 + clockOffset;

  const send = async (run: TableRun, what: string, ixs: TransactionInstruction[], signer = dealer, conn = er, cu?: number) => {
    try {
      const sig = await client.sendEr(conn, ixs, [signer], cu);
      log(run.name, `${what} ok ${sig}`);
      return { ok: true as const, sig };
    } catch (e) {
      const x = explainError(e);
      log(run.name, `${what} rejected: ${x.name ?? ""} ${x.short}`.replace(/\s+/g, " "));
      run.lastFail = Date.now();
      return { ok: false as const, err: x };
    }
  };
  const note = (run: TableRun, msg: string) => {
    if (run.lastNote !== msg) log(run.name, msg);
    run.lastNote = msg;
  };

  const step = async (run: TableRun, t: TableState) => {
    const now = erNow();
    const mySeat = t.seats.findIndex((s) => s.kind === "human" && s.owner.toBase58() === me);

    // Track newly seated humans (grace period). The dealer's own key is not a human player.
    const present = new Set<string>();
    t.seats.forEach((s, i) => {
      if (s.kind !== "human" || s.owner.toBase58() === me) return;
      const k = `${i}:${s.owner.toBase58()}`;
      present.add(k);
      if (!run.firstSeen.has(k)) {
        run.firstSeen.set(k, now);
        log(run.name, `human seated at seat ${i} (${s.owner.toBase58().slice(0, 6)}), grace ${HUMAN_GRACE_SECS}s`);
      }
    });
    for (const k of [...run.firstSeen.keys()]) if (!present.has(k)) run.firstSeen.delete(k);

    if (t.phase === "trading") {
      if (mySeat >= 0) {
        await send(run, `round ${t.round} trading: leave seat ${mySeat} (back to the house bot)`, [await client.leaveIx(dealer.publicKey, run.table, mySeat)]);
        return;
      }
      if (now > t.tradeEndTs + 8) {
        await send(run, `round ${t.round} bell overdue ${Math.round(now - t.tradeEndTs)}s: ring_bell`, [await client.ringBellIx(run.table)], dealer, er, 400_000);
        return;
      }
      note(run, `round ${t.round} trading, bell due at ${new Date(t.tradeEndTs * 1000).toISOString().slice(11, 19)}Z`);
      return;
    }

    if (t.phase === "dealing") {
      const stuck = now - t.dealRequestedTs;
      if (stuck < DEAL_RETRY_SECS + 2) {
        note(run, `round ${t.round} dealing (${Math.round(stuck)}s)`);
        return;
      }
      if (Date.now() - run.lastFail < 5000) return;
      if (mySeat >= 0) {
        await send(run, `round ${t.round} stuck in dealing ${Math.round(stuck)}s: start_round retry (VRF only)`, [await client.startRoundIx(dealer.publicKey, run.table, false)], dealer, er, 1_000_000);
      } else if (creator && creatorEr) {
        await send(run, `round ${t.round} stuck in dealing ${Math.round(stuck)}s: creator start_round retry (VRF only)`, [await client.startRoundIx(creator.publicKey, run.table, false)], creator, creatorEr, 1_000_000);
      } else {
        note(run, `round ${t.round} stuck in dealing ${Math.round(stuck)}s; the seated human or the creator must retry`);
      }
      return;
    }

    // lobby / settled
    if (mySeat >= 0) {
      await send(run, `between rounds: leave leftover seat ${mySeat}`, [await client.leaveIx(dealer.publicKey, run.table, mySeat)]);
      return;
    }
    if (t.phase === "settled" && t.recordsRound < t.round) {
      const r = await send(run, `round ${t.round} settled (scores ${t.scores.join("/")}, ranks ${t.ranks.join("/")}): publish_records`, [await client.publishRecordsIx(dealer.publicKey, run.table)]);
      if (r.ok || r.err.name === "AlreadyPublished") {
        if (run.started.has(t.round)) run.completed.add(t.round);
      }
      return;
    }
    if (t.phase === "settled" && run.started.has(t.round)) run.completed.add(t.round);
    // No new rounds once stopping, done, or within 2 min of the --minutes limit (so the last round
    // it starts still gets its bell published before it exits).
    if (stopping || (ROUNDS && run.completed.size >= ROUNDS) || Date.now() > deadline - 120_000) return;

    const settledFor = t.phase === "settled" ? now - t.tradeEndTs : Infinity;
    if (settledFor < GAP) {
      note(run, `round ${t.round} settled; next deal not before ${new Date((t.tradeEndTs + GAP) * 1000).toISOString().slice(11, 19)}Z`);
      return;
    }
    const inGrace = [...run.firstSeen.entries()].filter(([, ts]) => now - ts < HUMAN_GRACE_SECS);
    if (inGrace.length) {
      note(run, `waiting: human at seat ${inGrace.map(([k]) => k.split(":")[0]).join(",")} in pre-round grace`);
      return;
    }
    if (Date.now() / 1000 < run.notBefore) return;
    if (Date.now() - run.lastFail < 5000) return;

    // Re-read right before sending: a human may have joined or started a round meanwhile.
    const fresh = await client.fetchTable(er, run.table);
    if (fresh.phase !== t.phase || fresh.round !== t.round) return;
    const freshHumans = fresh.seats.filter((s, i) => s.kind === "human" && !run.firstSeen.has(`${i}:${s.owner.toBase58()}`));
    if (freshHumans.length) return; // new human: next step starts their grace
    const free = freeSeats(fresh);
    if (free.length === 0) {
      if (creator && creatorEr) {
        const r = await send(run, `all seats human: creator start_round ${fresh.round + 1} (crank)`, [await client.startRoundIx(creator.publicKey, run.table, true)], creator, creatorEr, 1_000_000);
        if (r.ok) run.started.add(fresh.round + 1);
      } else {
        note(run, "no free seat; seated humans must start the round");
      }
      return;
    }
    const seat = free[free.length - 1];
    const r = await send(
      run,
      `start round ${fresh.round + 1} (bots ${free.length}, humans ${4 - free.length}; dealer joins seat ${seat}, crank on)`,
      [await client.joinIx(dealer.publicKey, run.table, seat), await client.startRoundIx(dealer.publicKey, run.table, true)],
      dealer,
      er,
      1_000_000,
    );
    if (r.ok) run.started.add(fresh.round + 1);
  };

  for (;;) {
    if (Date.now() - clockAt > 30_000) {
      clockOffset = (await client.erUnixTime(er)) - Date.now() / 1000;
      clockAt = Date.now();
    }
    if (Date.now() > token.expiresAt - 10 * 60_000) await reauth("token about to expire");
    const states = await Promise.all(runs.map((r) => client.fetchTable(er, r.table).catch((e) => e as Error)));
    readFailures = states.every((s) => s instanceof Error) ? readFailures + 1 : 0;
    if (readFailures >= 5) await reauth("5 polls in a row could not read any table");
    for (let i = 0; i < runs.length; i++) {
      const s = states[i];
      if (s instanceof Error) {
        note(runs[i], `read failed: ${s.message.slice(0, 120)}`);
        continue;
      }
      try {
        await step(runs[i], s);
      } catch (e) {
        log(runs[i].name, `step error: ${explainError(e).short}`);
      }
    }
    const allDone = ROUNDS > 0 && runs.every((r) => r.completed.size >= ROUNDS);
    const timeUp = Date.now() > deadline;
    if (allDone || timeUp || stopping) {
      // Only exit once the dealer holds no seat (it gives seats back when trading opens).
      const held = states.some((s) => !(s instanceof Error) && s.seats.some((x) => x.kind === "human" && x.owner.toBase58() === me));
      if (!held) {
        console.log(
          `dealer stopping (${allDone ? "rounds done" : timeUp ? "time limit" : "signal"}); completed rounds: ` +
            runs.map((r) => `${r.name}=${[...r.completed].sort((a, b) => a - b).join(",") || "-"}`).join(" "),
        );
        break;
      }
    }
    await sleep(POLL_MS);
  }
}

main().catch((e) => {
  console.error("dealer fatal:", explainError(e).detail);
  process.exit(1);
});

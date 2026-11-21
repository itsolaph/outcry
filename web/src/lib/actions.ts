// Player actions. Every ER transaction is signed by the 0-SOL session key (fee payer); the wallet
// only co-signs `join` when one is connected.
import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { OutcryErrorInfo, Side, TableState, bestAsk, bestBid, explainError, recordPda, teeUrl } from "@outcry/client";
import { TEE_RPC } from "../config";
import { anonEr, client, myEr, sessionKey, sessionToken } from "./outcry";
import { addTx } from "./txlog";
import { walletPubkey, walletSendBase, walletSign } from "./wallet";

export type ActionResult = { ok: true; sig: string } | { ok: false; error: OutcryErrorInfo };

async function sendEr(label: string, table: PublicKey, round: number, ixs: TransactionInstruction[], cu?: number, withWallet = false): Promise<ActionResult> {
  try {
    const kp = sessionKey();
    const er = await myEr();
    let tx = await client.buildErTx(er, ixs, kp.publicKey, cu);
    if (withWallet) {
      // The wallet signs first (it is not the fee payer), then the session key adds its signature.
      try {
        tx = await walletSign(tx);
      } catch (e) {
        return { ok: false, error: { name: "WalletDeclined", short: "the wallet did not sign", detail: String((e as Error)?.message ?? e), logs: [] } };
      }
      tx.partialSign(kp);
    } else {
      tx.sign(kp);
    }
    const sig = await client.sendSignedEr(er, tx.serialize());
    addTx({ sig, label, layer: "er", table: table.toBase58(), round });
    return { ok: true, sig };
  } catch (e) {
    const error = explainError(e);
    console.warn(`[outcry] ${label} failed:`, error.name ?? "", error.detail, error.logs.slice(-6));
    return { ok: false, error };
  }
}

/**
 * Starting a round needs the last round's records published first: `publish_records` only runs in
 * `settled`, so a start that beats the dealer would drop them. Prepend it when it is still due,
 * and retry without it if someone else published in the meantime.
 */
async function withPublishFirst(
  table: PublicKey,
  t: TableState,
  send: (pre: TransactionInstruction[]) => Promise<ActionResult>,
): Promise<ActionResult> {
  const me = sessionKey().publicKey;
  const due = t.phase === "settled" && t.recordsRound < t.round;
  if (!due) return send([]);
  const r = await send([await client.publishRecordsIx(me, table)]);
  if (!r.ok && r.error.name === "AlreadyPublished") return send([]);
  return r;
}

/**
 * Sit down in a free bot seat and deal the next round right away (one ER transaction). With a
 * wallet connected the wallet co-signs `join`; if it declines, the guest is seated without it.
 */
export async function joinTable(table: PublicKey, t: TableState, seat: number, startNow: boolean): Promise<ActionResult & { walletBound?: boolean }> {
  const me = sessionKey().publicKey;
  const attempt = async (wallet: PublicKey | null) =>
    withPublishFirst(table, t, async (pre) => {
      const ixs = [...pre, await client.joinIx(me, table, seat, wallet ?? undefined)];
      if (startNow) ixs.push(await client.startRoundIx(me, table, true));
      const label = startNow ? `join seat ${seat} + start round ${t.round + 1}` : `join seat ${seat}`;
      return sendEr(label, table, t.round + (startNow ? 1 : 0), ixs, startNow ? 1_400_000 : 400_000, !!wallet);
    });
  const wallet = walletPubkey();
  if (wallet) {
    const r = await attempt(wallet);
    if (r.ok || r.error.name !== "WalletDeclined") return { ...r, walletBound: r.ok };
  }
  return attempt(null);
}

export async function startRound(table: PublicKey, t: TableState, retry = false): Promise<ActionResult> {
  const me = sessionKey().publicKey;
  const label = retry ? `retry deal round ${t.round}` : `start round ${t.round + 1}`;
  // A retry re-requests VRF for the same round; the first crank is still scheduled.
  if (retry) return sendEr(label, table, t.round, [await client.startRoundIx(me, table, false)], 1_000_000);
  return withPublishFirst(table, t, async (pre) =>
    sendEr(label, table, t.round + 1, [...pre, await client.startRoundIx(me, table, true)], 1_400_000),
  );
}

export async function quote(table: PublicKey, t: TableState, seat: number, suit: number, side: Side, price: number) {
  const me = sessionKey().publicKey;
  return sendEr(`${side === 0 ? "bid" : "offer"} ${price} ${["spades", "clubs", "hearts", "diamonds"][suit]}`, table, t.round, [await client.quoteIx(me, table, seat, suit, side, price)]);
}

export async function cancel(table: PublicKey, t: TableState, seat: number, suit: number, side: Side) {
  const me = sessionKey().publicKey;
  return sendEr(`cancel ${side === 0 ? "bid" : "offer"} ${["spades", "clubs", "hearts", "diamonds"][suit]}`, table, t.round, [await client.cancelIx(me, table, seat, suit, side)]);
}

/**
 * Take a resting quote. `take` has no price argument, so re-read the book first and refuse if the
 * level moved (a re-quote between click and landing would otherwise fill at the new price).
 */
export async function take(table: PublicKey, seat: number, suit: number, side: Side, counterparty: number, expectPrice: number): Promise<ActionResult> {
  let fresh: TableState;
  try {
    fresh = await client.fetchTable(anonEr, table);
  } catch (e) {
    return { ok: false, error: explainError(e) };
  }
  const now = side === 1 ? fresh.asks[suit][counterparty] : fresh.bids[suit][counterparty];
  if (now !== expectPrice) {
    return { ok: false, error: { name: "NoQuote", short: "book moved", detail: `quote changed from ${expectPrice} to ${now || "none"}`, logs: [] } };
  }
  const me = sessionKey().publicKey;
  const verb = side === 1 ? "buy" : "sell";
  const who = ["Red", "Green", "Gold", "Blue"][counterparty];
  return sendEr(`${verb} 1 ${["spades", "clubs", "hearts", "diamonds"][suit]} @${expectPrice} ${side === 1 ? "from" : "to"} ${who}`, table, fresh.round, [await client.takeIx(me, table, seat, suit, side, counterparty)]);
}

export function bestLevels(t: TableState, suit: number, mySeat: number) {
  return { bid: bestBid(t, suit, mySeat), ask: bestAsk(t, suit, mySeat) };
}

export async function leave(table: PublicKey, t: TableState, seat: number) {
  const me = sessionKey().publicKey;
  // Publish first if the settled round is still unpublished: `publish_records` reads the live
  // roster, so leaving first would drop a wallet-bound seat's record.
  const r = await withPublishFirst(table, t, async (pre) =>
    sendEr(`leave seat ${seat}`, table, t.round, [...pre, await client.leaveIx(me, table, seat)], pre.length ? 400_000 : undefined),
  );
  if (r.ok) clearPreparedLeave();
  return r;
}

/** Rebind my seat to the connected wallet between rounds: leave + join in one transaction. */
export async function bindWallet(table: PublicKey, t: TableState, seat: number) {
  const me = sessionKey().publicKey;
  const wallet = walletPubkey();
  if (!wallet) return { ok: false as const, error: { short: "connect a wallet first", detail: "", logs: [] } };
  return sendEr(`bind seat ${seat} to wallet`, table, t.round, [await client.leaveIx(me, table, seat), await client.joinIx(me, table, seat, wallet)], undefined, true);
}

export async function publishRecords(table: PublicKey, t: TableState) {
  const me = sessionKey().publicKey;
  return sendEr(`publish records round ${t.round}`, table, t.round, [await client.publishRecordsIx(me, table)]);
}

/** Base layer, wallet pays: create the wallet's PlayerRecord (once). */
export async function initRecord(): Promise<ActionResult> {
  const wallet = walletPubkey();
  if (!wallet) return { ok: false, error: { short: "connect a wallet first", detail: "", logs: [] } };
  try {
    const tx = new Transaction().add(await client.initRecordIx(wallet, wallet));
    const sig = await walletSendBase(tx);
    addTx({ sig, label: "create player record", layer: "base" });
    return { ok: true, sig };
  } catch (e) {
    return { ok: false, error: explainError(e) };
  }
}

export function myRecordAddress(): string | null {
  const w = walletPubkey();
  return w ? recordPda(w, client.programId).toBase58() : null;
}

// ------------------------------------------------------------------ leave on page close

let prepared: { body: string; at: number; key: string; url: string } | null = null;

/** Keep a signed `leave` ready (fresh blockhash) so it can be fired from `pagehide`. */
export async function prepareLeave(table: PublicKey, seat: number): Promise<void> {
  const key = `${table.toBase58()}:${seat}`;
  if (prepared && prepared.key === key && Date.now() - prepared.at < 8_000) return;
  const kp = sessionKey();
  const er = await myEr();
  const tx = await client.buildErTx(er, [await client.leaveIx(kp.publicKey, table, seat)], kp.publicKey);
  tx.sign(kp);
  const b64 = tx.serialize().toString("base64");
  prepared = {
    key,
    at: Date.now(),
    url: teeUrl(TEE_RPC, (await sessionToken()).token),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [b64, { encoding: "base64", skipPreflight: true }] }),
  };
}

export function clearPreparedLeave(): void {
  prepared = null;
}

/** Fire-and-forget the prepared `leave` (survives page unload via `keepalive`). */
export function firePreparedLeave(): void {
  if (!prepared) return;
  try {
    fetch(prepared.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: prepared.body, keepalive: true });
  } catch {
    // best effort
  }
  prepared = null;
}

export interface RoundTxs {
  /** start_round: sealed the seat permissions and requested VRF */
  seal?: string;
  /** VRF callback that dealt the round (readable once the bell has flipped the seats public) */
  deal?: string;
  /** crank tick that rang the bell and flipped the permissions public */
  bell?: string;
}

/**
 * Find a settled round's key transactions through seat 0 (start, deal and bell all write it).
 * Every crank `bot_tick` lists the seats too (about two signatures a second), so pick by time and
 * confirm by logs: the seal is the StartRound at `dealRequestedTs`, the deal the `Deal` callback
 * right after it, the bell the first tick at or after `tradeEndTs` with a permission-program CPI.
 */
export async function findRoundTxs(table: PublicKey, t: TableState): Promise<RoundTxs> {
  const PERMISSION_PROGRAM = "ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1";
  try {
    const seat0 = client.seats(table)[0];
    let sigs = await anonEr.getSignaturesForAddress(seat0, { limit: 200 });
    for (let page = 0; page < 3; page++) {
      const oldest = sigs[sigs.length - 1];
      if (!oldest?.blockTime || oldest.blockTime < t.dealRequestedTs - 1) break;
      const more = await anonEr.getSignaturesForAddress(seat0, { limit: 200, before: oldest.signature });
      if (more.length === 0) break;
      sigs = sigs.concat(more);
    }
    const ok = sigs.filter((s) => !s.err && s.blockTime != null).reverse(); // oldest first
    const logsOf = async (sig: string) =>
      (await anonEr.getTransaction(sig, { maxSupportedTransactionVersion: 0 }).catch(() => null))?.meta?.logMessages ?? [];
    const pick = async (cands: typeof ok, test: (logs: string[]) => boolean) => {
      const logs = await Promise.all(cands.map((c) => logsOf(c.signature)));
      return cands.find((_, i) => test(logs[i]))?.signature;
    };
    const atStart = ok.filter((s) => s.blockTime! >= t.dealRequestedTs - 1 && s.blockTime! <= t.dealRequestedTs + 3).slice(0, 10);
    const afterBell = ok.filter((s) => s.blockTime! >= t.tradeEndTs).slice(0, 4);
    const [seal, deal, bell] = await Promise.all([
      pick(atStart, (l) => l.some((x) => x.includes("Instruction: StartRound"))),
      pick(atStart, (l) => l.some((x) => x.includes("Instruction: Deal"))),
      pick(afterBell, (l) => l.some((x) => x.includes(`${PERMISSION_PROGRAM} invoke`))),
    ]);
    return { seal, deal, bell };
  } catch {
    return {};
  }
}

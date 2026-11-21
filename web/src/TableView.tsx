import { CSSProperties, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import {
  SIDE_ASK,
  SIDE_BID,
  SeatState,
  Side,
  TableState,
  TradePrint,
  bestAsk,
  bestBid,
  canJoin,
  freeSeats,
  orderFilled,
  orderRequirement,
  seatOf,
} from "@outcry/client";
import { HOUSE_TABLES, TEE_RPC } from "./config";
import * as act from "./lib/actions";
import { useErNow, useLiveTable, useMySeat, useReveal } from "./lib/hooks";
import { client, myEr, sessionKey } from "./lib/outcry";
import { TxEntry, useTxLog } from "./lib/txlog";
import { useWallet } from "./lib/wallet";
import { AddrLink, Card, Pip, Roll, Seat, Suit, Tick, TxLink, fmtClock, go, ordinal, quoteText, seatKind, toast, useChanges } from "./ui";

const BONUS = 100;
const SUIT_ONE = ["spade", "club", "heart", "diamond"];
const SUIT_MANY = ["spades", "clubs", "hearts", "diamonds"];
/** Prints shown on the live tape before "Show all". */
const TAPE_SHORT = 10;
/** Cards drawn in one stack of the hand; the count on the top card stays exact beyond it. */
const STACK_MAX = 8;
/** Trade lines on the table that carry their price; older lines stay as faint strokes. */
const FELT_LABELS = 5;

/** The action layer logs seats by index and by their former colour names; show them as seat numbers. */
function txLabel(label: string): string {
  return label
    .replace(/\b(Red|Green|Gold|Blue)$/, (w) => `seat ${["Red", "Green", "Gold", "Blue"].indexOf(w) + 1}`)
    .replace(/\bseat (\d)\b(?! \d)/, (_, n) => `seat ${Number(n) + (/^(join|leave|bind)/.test(label) ? 1 : 0)}`);
}

/** Prints of the current round, oldest first. */
function roundTape(t: TableState): TradePrint[] {
  return t.tape.filter((p) => p.round === t.round);
}

function useQuery(): URLSearchParams {
  const h = window.location.hash;
  const i = h.indexOf("?");
  return new URLSearchParams(i >= 0 ? h.slice(i + 1) : "");
}

export function TableView({ address }: { address: string }) {
  const house = HOUSE_TABLES.find((h) => h.address === address);
  const tablePk = useMemo(() => new PublicKey(address), [address]);
  const { table: t, error, source, refresh } = useLiveTable(address);
  const now = useErNow(250);
  const me = sessionKey().publicKey.toBase58();
  const mySeat = t ? seatOf(t, me) : -1;
  const seat = useMySeat(address, mySeat, t);
  const reveal = useReveal(address, t);
  const wallet = useWallet();
  const query = useQuery();
  const [wantSeat, setWantSeat] = useState(query.get("play") === "1");
  const [busy, setBusy] = useState<string | null>(null);
  const joining = useRef(false);
  const retried = useRef<number>(-1);
  const [privacyProbe, setPrivacyProbe] = useState<{ round: number; seat: number; at: number; hidden: boolean } | null>(null);

  // ---- take a seat (Play now / Take a seat): join + start in one transaction
  useEffect(() => {
    if (!t || !wantSeat || mySeat >= 0 || joining.current) return;
    if (!canJoin(t)) return;
    const free = freeSeats(t);
    if (free.length === 0) {
      setWantSeat(false);
      toast("bad", "This table is full. Pick another one in the lobby.");
      return;
    }
    joining.current = true;
    setBusy("Taking a seat and dealing…");
    (async () => {
      // A short random delay spreads simultaneous guests over different seats.
      const s = free[Math.floor(Math.random() * free.length)];
      const r = await act.joinTable(tablePk, t, s, true);
      if (r.ok) {
        setWantSeat(false);
        const bound = r.walletBound ? " Bound to your wallet." : wallet.account ? " The wallet did not sign, so the seat is not bound to it." : "";
        toast("ok", `You are in seat ${s + 1}. Dealing.${bound}`, r.sig);
      } else if (r.error.name === "RoundInProgress" || r.error.name === "SeatTaken") {
        // Someone dealt or sat down first: stay queued, and join at the next bell (or another seat).
        toast("info", r.error.name === "SeatTaken" ? "That seat was just taken. Trying another." : "A round was just dealt here. You are seated at the next bell.");
      } else {
        setWantSeat(false); // never loop on other failures; the player can retry
        toast("bad", `Could not take a seat: ${r.error.short}`);
      }
      await refresh();
      joining.current = false;
      setBusy(null);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, wantSeat, mySeat, tablePk, refresh]);

  // ---- a deal that has not arrived after the program's 20 s retry window: re-request VRF once
  useEffect(() => {
    if (!t || mySeat < 0 || t.phase !== "dealing") return;
    if (now - t.dealRequestedTs < 23 || retried.current === t.round) return;
    retried.current = t.round;
    act.startRound(tablePk, t, true).then((r) => {
      if (r.ok) toast("info", "The deal was late, so it was requested again.", r.sig);
    });
  }, [t, now, mySeat, tablePk]);

  // ---- sign a `leave` as soon as I am seated (the app-level seat keeper refreshes and fires it)
  useEffect(() => {
    if (mySeat >= 0) act.prepareLeave(tablePk, mySeat).catch(() => {});
  }, [mySeat, tablePk]);

  // ---- once per round: prove a bot seat is hidden from my token while trading
  useEffect(() => {
    if (!t || mySeat < 0 || t.phase !== "trading" || privacyProbe?.round === t.round) return;
    const other = [0, 1, 2, 3].find((i) => i !== mySeat)!;
    (async () => {
      const er = await myEr();
      const r = await client.readSeat(er, tablePk, other);
      setPrivacyProbe({ round: t.round, seat: other, at: Date.now(), hidden: !r.visible || r.value.round !== t.round || r.value.chips === 0 });
    })().catch(() => {});
  }, [t, mySeat, tablePk, privacyProbe]);

  // ---- after the bell: publish records if nobody has yet (the house dealer usually does)
  // (keyed on round/phase only: table updates arrive every second and must not reset the timer)
  const needPublish = !!t && mySeat >= 0 && t.phase === "settled" && t.recordsRound < t.round;
  const settledRound = t?.round ?? -1;
  useEffect(() => {
    if (!needPublish) return;
    const id = setTimeout(async () => {
      const fresh = await refresh();
      if (fresh && fresh.phase === "settled" && fresh.round === settledRound && fresh.recordsRound < fresh.round) {
        const r = await act.publishRecords(tablePk, fresh);
        if (r.ok) toast("ok", "Round results sent to the base layer.", r.sig);
      }
    }, 3000);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needPublish, settledRound, tablePk]);

  if (!t) {
    // Skeleton: the clock spot and its bar hold the page's shape while the rollup answers.
    return (
      <main className="table-page container" data-phase="loading">
        <TableHeader name={house?.name ?? address.slice(0, 6)} address={address} />
        <div className="cols">
          <div className="col-main">
            <section className="bell is-idle">
              <p className="clock" aria-hidden="true">
                <Roll text="0:00" />
              </p>
              <div className="drain" aria-hidden="true" />
              <p className={`bell-note ${error ? "is-bad" : ""}`}>
                <span>{error ? `This table could not be read from the rollup: ${error}` : "Reading the table from the rollup…"}</span>
              </p>
            </section>
          </div>
        </div>
      </main>
    );
  }

  const run = async (label: string, f: () => Promise<act.ActionResult>, okText?: string) => {
    setBusy(label);
    const r = await f();
    setBusy(null);
    if (r.ok) {
      if (okText) toast("ok", okText, r.sig);
    } else toast("bad", `Rejected: ${r.error.short}`);
    refresh();
    return r;
  };

  const mine = seat && seat.visible && seat.value.round === t.round ? seat.value : null;

  const leaveNow = async () => {
    const r = await run("Leaving…", () => act.leave(tablePk, t, mySeat), "Seat handed back to the house bot.");
    if (r.ok) go("/");
  };

  const settled = t.phase === "settled";
  const trading = t.phase === "trading";

  return (
    <main className="table-page container" data-phase={t.phase}>
      <TableHeader name={house?.name ?? address.slice(0, 6)} address={address} round={t.round} source={source} />

      <div className="cols">
        <div className="col-main">
          {settled ? (
            <Result t={t} mySeat={mySeat} me={me} busy={busy}>
              {mySeat >= 0 ? (
                <div className="after-actions">
                  <button className="btn btn-fill" disabled={!!busy} data-testid="next-round" onClick={() => run("Dealing the next round…", () => act.startRound(tablePk, t), "Next round requested.")}>
                    Deal the next round
                  </button>
                  {wallet.account && t.seats[mySeat].wallet.toBase58() !== wallet.account.address ? (
                    <button className="btn btn-line" disabled={!!busy} onClick={() => run("Binding your wallet…", () => act.bindWallet(tablePk, t, mySeat), "Seat bound to your wallet.")}>
                      Bind seat to my wallet
                    </button>
                  ) : null}
                  <button className="btn btn-line" disabled={!!busy} data-testid="leave" onClick={leaveNow}>
                    Leave the table
                  </button>
                </div>
              ) : null}
            </Result>
          ) : (
            <Bell t={t} now={now} busy={busy} />
          )}

          {mySeat < 0 ? <SeatBar t={t} now={now} wantSeat={wantSeat} busy={busy} onSit={() => setWantSeat(true)} /> : null}
          {trading && mySeat >= 0 ? <Ticket mine={mine} /> : null}
          {trading ? <Book t={t} mySeat={mySeat} me={me} mine={mine} busy={!!busy} run={run} tablePk={tablePk} /> : null}
          {settled ? <Hands t={t} me={me} mySeat={mySeat} reveal={reveal} /> : null}
        </div>

        <div className="col-side">
          {!settled ? <Seats t={t} me={me} mySeat={mySeat} /> : null}
          {trading ? <Tape t={t} mySeat={mySeat} me={me} /> : null}
          {settled ? <Scoreboard t={t} mySeat={mySeat} me={me} /> : null}
          {settled ? <TapeReplay t={t} me={me} mySeat={mySeat} /> : null}
        </div>
      </div>

      {settled ? (
        <PrivacyStory t={t} tablePk={tablePk} probe={privacyProbe?.round === t.round ? privacyProbe : null} mySeat={mySeat} walletAddr={wallet.account?.address ?? null} />
      ) : null}

      <div className="table-foot">
        {mySeat >= 0 && !settled ? (
          <p className="seat-foot">
            You are in seat {mySeat + 1}.{" "}
            <button className="linkish" onClick={leaveNow}>
              Leave the table
            </button>{" "}
            and a house bot finishes your hand.
          </p>
        ) : null}
        <MyTxs address={address} round={t.round} />
        <p className="rpc-note">
          Table state streams from the TEE rollup at <code>{TEE_RPC.replace(/^https:\/\//, "")}</code> ({source === "ws" ? "live subscription" : "polling"}).
        </p>
      </div>

      {trading && mySeat >= 0 && mine ? <Cockpit t={t} mine={mine} now={now} /> : null}
    </main>
  );
}

function TableHeader({ name, address, round, source }: { name: string; address: string; round?: number; source?: string }) {
  return (
    <header className="table-head">
      <h1>
        {name}
        {round !== undefined ? (
          <span className="round">
            {" "}
            round <Tick v={round} className="num" />
          </span>
        ) : null}
      </h1>
      <p className="head-meta">
        {source ? <span>{source === "ws" ? "Live updates" : "Polling for updates"}</span> : null}
        <AddrLink addr={address} layer="er">
          Table account
        </AddrLink>
      </p>
    </header>
  );
}

// ------------------------------------------------------------------ the bell clock (the one loud thing)

function Bell({ t, now, busy }: { t: TableState; now: number; busy: string | null }) {
  const trading = t.phase === "trading";
  const left = t.tradeEndTs - now;
  const frac = trading ? Math.max(0, Math.min(1, left / t.windowSecs)) : t.phase === "dealing" ? 1 : 0;
  const late = trading && left < 10;
  return (
    <section className={`bell ${trading ? "" : "is-idle"} ${late ? "is-late" : ""}`} aria-label="Bell clock">
      <p
        className="clock"
        role="timer"
        aria-label={trading ? `${fmtClock(left)} until the bell` : undefined}
        data-testid={trading || t.phase === "dealing" ? "bell-clock" : undefined}
      >
        <Roll text={fmtClock(trading ? left : t.windowSecs)} />
      </p>
      <div className="drain" aria-hidden="true">
        <span className="drain-fill" style={{ transform: `scaleX(${frac})` }} />
      </div>
      <p className="bell-note">
        <span>
          {trading
            ? "Until the bell"
            : t.phase === "dealing"
              ? "Dealing. The shuffle uses verifiable randomness and lands in sealed seats, so nobody sees a hand but its owner."
              : "No round has been dealt here yet. Take a seat to deal the first one."}
        </span>
        {busy ? (
          <span className="busy" data-testid="busy">
            {busy}
          </span>
        ) : null}
      </p>
    </section>
  );
}

/** After the bell the clock spot holds the result, at the clock's own scale. */
function Result({ t, mySeat, me, busy, children }: { t: TableState; mySeat: number; me: string; busy: string | null; children?: ReactNode }) {
  const winner = t.ranks.indexOf(0);
  const seated = mySeat >= 0;
  const chips = seated ? t.scores[mySeat] - (t.filled[mySeat] ? BONUS : 0) : 0;
  const order = [0, 1, 2, 3].sort((a, b) => t.ranks[a] - t.ranks[b]);
  return (
    <section className="bell reveal" data-testid="reveal">
      <div className="result-row">
        {seated ? (
          <h2 className="clock result" aria-label={`You finished ${ordinal(t.ranks[mySeat] + 1)} with ${t.scores[mySeat]}`}>
            <span aria-hidden="true">{ordinal(t.ranks[mySeat] + 1)}</span>
          </h2>
        ) : (
          <h2 className="clock result">Bell</h2>
        )}
        <p className="finals" aria-label="Final scores, best first">
          {order.map((i) => (
            <span key={i} className={i === mySeat ? "is-me" : ""}>
              <Seat seat={i} kind={seatKind(t, i, me)} />
              <span className="num">{t.scores[i]}</span>
            </span>
          ))}
        </p>
      </div>
      <div className="drain" aria-hidden="true" />
      <p className="bell-note">
        <span>
          {seated
            ? `Round ${t.round} is over. Your score is ${chips} chips${t.filled[mySeat] ? " + 100 for the filled order" : ", order missed"}.`
            : `Round ${t.round} is over. ${winner >= 0 ? `Seat ${winner + 1} won with ${t.scores[winner]}. ` : ""}Every hand is face up.`}
        </span>
        {busy ? (
          <span className="busy" data-testid="busy">
            {busy}
          </span>
        ) : null}
      </p>
      {children}
    </section>
  );
}

function SeatBar({ t, now, wantSeat, busy, onSit }: { t: TableState; now: number; wantSeat: boolean; busy: string | null; onSit: () => void }) {
  const free = freeSeats(t);
  if (free.length === 0) {
    return (
      <div className="seatbar">
        <p>Every seat here is taken by a player. Watch, or pick another table in the lobby.</p>
      </div>
    );
  }
  if (canJoin(t)) {
    return (
      <div className="seatbar">
        <p>
          {free.length} of 4 seats are held by house bots. Sit in one and the next round deals at once.
        </p>
        <button className="btn btn-fill" data-testid="take-seat" disabled={wantSeat || !!busy} onClick={onSit}>
          Take a seat
        </button>
      </div>
    );
  }
  return (
    <div className="seatbar">
      {wantSeat ? (
        <p data-testid="queued">
          Seating you at the bell in <Tick v={fmtClock(Math.max(0, t.tradeEndTs - now))} className="num" />.
        </p>
      ) : (
        <>
          <p>You are watching. Seats open between rounds.</p>
          <button className="btn btn-line" onClick={onSit}>
            Seat me at the bell
          </button>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ my order and hand

function Ticket({ mine }: { mine: SeatState | null }) {
  if (!mine) {
    return (
      <section className="order is-loading" data-testid="my-ticket">
        <p className="quiet">Reading your sealed seat with your key…</p>
      </section>
    );
  }
  const need = orderRequirement(mine.order);
  const filled = orderFilled(mine);
  return (
    <section className="order" data-testid="my-ticket" aria-label="Your private hand and order">
      <div className="sec-head">
        <h2>Your hand</h2>
        <p>Only you can see this. Hold your whole order at the bell for 100 more.</p>
      </div>
      <div className="order-main">
        <div className="hand" data-testid="my-hand">
          {mine.hand.map((n, s) => {
            const short = need[s] - n;
            const depth = Math.min(n, STACK_MAX);
            return (
              <div key={s} className={`hold s${s} ${short > 0 ? "hold-short" : ""}`}>
                <span className="stack" style={{ "--n": depth } as CSSProperties} aria-hidden="true">
                  {n === 0 ? (
                    <span className="pc pc-empty">
                      <Pip s={s} className="pc-mid" />
                    </span>
                  ) : (
                    Array.from({ length: depth }, (_, j) => <Card key={j} s={s} n={j === depth - 1 ? n : undefined} style={{ "--j": j } as CSSProperties} />)
                  )}
                </span>
                <span className="hold-note">
                  <span className="sr-only">
                    {n} {n === 1 ? SUIT_ONE[s] : SUIT_MANY[s]},{" "}
                  </span>
                  {short > 0 ? `need ${short}` : short < 0 ? `spare ${-short}` : need[s] ? "covered" : "none"}
                </span>
              </div>
            );
          })}
        </div>
        <div className="order-side">
          <p className="order-big num" data-testid="my-order" aria-label={`Your order: ${mine.order.qtyA} ${SUIT_MANY[mine.order.suitA]} and ${mine.order.qtyB} ${SUIT_MANY[mine.order.suitB]}`}>
            <span className="order-label">Order</span> {mine.order.qtyA} <Suit s={mine.order.suitA} /> + {mine.order.qtyB} <Suit s={mine.order.suitB} />
          </p>
          <p className="order-foot">
            <span>
              <b className="num" data-testid="my-chips">
                <Tick v={mine.chips} />
              </b>{" "}
              chips
            </span>
            <span>
              At the bell now: <b className="num">{mine.chips + (filled ? BONUS : 0)}</b>
            </span>
            <span>{filled ? "Order filled, +100" : "Order not filled"}</span>
          </p>
        </div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ the market (one row per suit)

type Run = (label: string, f: () => Promise<act.ActionResult>, okText?: string) => Promise<act.ActionResult>;

function Book({ t, mySeat, me, mine, busy, run, tablePk }: { t: TableState; mySeat: number; me: string; mine: SeatState | null; busy: boolean; run: Run; tablePk: PublicKey }) {
  const need = mine ? orderRequirement(mine.order) : [0, 0, 0, 0];
  const seated = mySeat >= 0 && !!mine;
  return (
    <section className="book" aria-label="Market" data-testid="book">
      <div className="sec-head">
        <h2>Market</h2>
        <p>{seated ? "Take the best price, or quote your own." : "Best prices from the seats. Take a seat to trade."}</p>
      </div>
      {[0, 1, 2, 3].map((s) => {
        const bid = bestBid(t, s, mySeat);
        const ask = bestAsk(t, s, mySeat);
        const want = need[s] - (mine?.hand[s] ?? 0);
        return (
          <div className={`book-row s${s} ${want > 0 ? "row-want" : ""} ${seated ? "is-seated" : ""}`} key={s} data-testid={`book-row-${s}`}>
            <div className="book-suit">
              <Suit s={s} withName />
              {seated ? <span className="book-need">{want > 0 ? `need ${want}` : mine!.hand[s] > 0 ? `${mine!.hand[s]} held` : "none held"}</span> : null}
            </div>
            <Take
              side="sell"
              s={s}
              q={bid}
              kind={bid ? seatKind(t, bid.seat, me) : "bot"}
              live={seated && !!bid}
              disabled={!seated || !bid || busy}
              title={bid ? `Sell one ${SUIT_ONE[s]} to seat ${bid.seat + 1} at ${bid.price}` : "No bid"}
              onClick={() => bid && run("Selling…", () => act.take(tablePk, mySeat, s, SIDE_BID, bid.seat, bid.price), `Sold 1 at ${bid.price}.`)}
            />
            <Take
              side="buy"
              s={s}
              q={ask}
              kind={ask ? seatKind(t, ask.seat, me) : "bot"}
              live={seated && !!ask}
              disabled={!seated || !ask || busy}
              title={ask ? `Buy one ${SUIT_ONE[s]} from seat ${ask.seat + 1} at ${ask.price}` : "No offer"}
              onClick={() => ask && run("Buying…", () => act.take(tablePk, mySeat, s, SIDE_ASK, ask.seat, ask.price), `Bought 1 at ${ask.price}.`)}
            />
            {seated ? <QuoteBox t={t} s={s} mySeat={mySeat} mine={mine!} want={want} busy={busy} run={run} tablePk={tablePk} /> : null}
          </div>
        );
      })}
    </section>
  );
}

/** A take button: the best price on one side of one suit. The price flashes when the best quote changes. */
function Take({
  side,
  s,
  q,
  kind,
  live,
  disabled,
  title,
  onClick,
}: {
  side: "sell" | "buy";
  s: number;
  q: { seat: number; price: number } | null;
  kind: string;
  live: boolean;
  disabled: boolean;
  title: string;
  onClick: () => void;
}) {
  const changes = useChanges(q?.price ?? 0);
  return (
    <button className={`take ${live ? "is-live" : ""}`} data-testid={`${side}-${s}`} disabled={disabled} title={title} onClick={onClick}>
      {changes > 0 ? <span key={changes} className="flash" aria-hidden="true" /> : null}
      <span className="take-side">{side === "sell" ? "Sell" : "Buy"}</span>
      <span className="take-px num">{q ? <Tick v={q.price} /> : "–"}</span>
      {q ? (
        <span className={`seat is-${kind}`} aria-hidden="true">
          {q.seat + 1}
        </span>
      ) : null}
    </button>
  );
}

function QuoteBox({ t, s, mySeat, mine, want, busy, run, tablePk }: { t: TableState; s: number; mySeat: number; mine: SeatState; want: number; busy: boolean; run: Run; tablePk: PublicKey }) {
  const myBid = t.bids[s][mySeat];
  const myAsk = t.asks[s][mySeat];
  const bid = bestBid(t, s, mySeat);
  const ask = bestAsk(t, s, mySeat);
  const suggested = want > 0 ? Math.min(99, (bid?.price ?? 14) + 1) : Math.max(1, (ask?.price ?? 30) - 1);
  const [px, setPx] = useState<string>(String(suggested));
  const price = Math.round(Number(px));
  const valid = price >= 1 && price <= 99;
  const send = (side: Side) =>
    run(side === SIDE_BID ? "Bidding…" : "Offering…", () => act.quote(tablePk, t, mySeat, s, side, price), side === SIDE_BID ? `Bid ${price} posted.` : `Offer ${price} posted.`);
  return (
    <div className="quote">
      {myBid || myAsk ? (
      <span className="my-quotes">
        {myBid ? (
          <button className="token" aria-label={`Cancel my bid at ${myBid}`} title="Cancel my bid" onClick={() => run("Cancelling…", () => act.cancel(tablePk, t, mySeat, s, SIDE_BID), "Bid cancelled.")}>
            My bid <span className="num">{myBid}</span> <span aria-hidden="true">×</span>
          </button>
        ) : null}
        {myAsk ? (
          <button className="token" aria-label={`Cancel my offer at ${myAsk}`} title="Cancel my offer" onClick={() => run("Cancelling…", () => act.cancel(tablePk, t, mySeat, s, SIDE_ASK), "Offer cancelled.")}>
            My offer <span className="num">{myAsk}</span> <span aria-hidden="true">×</span>
          </button>
        ) : null}
      </span>
      ) : null}
      <label className="sr-only" htmlFor={`px-${s}`}>
        Price for {SUIT_MANY[s]}
      </label>
      <input id={`px-${s}`} className="px num" inputMode="numeric" placeholder="1-99" autoComplete="off" value={px} data-testid={`px-${s}`} onChange={(e) => setPx(e.target.value.replace(/[^0-9]/g, "").slice(0, 2))} />
      <button className="btn btn-line btn-q" data-testid={`bid-${s}`} disabled={busy || !valid || mine.chips < price} onClick={() => send(SIDE_BID)}>
        Bid
      </button>
      <button className="btn btn-line btn-q" data-testid={`offer-${s}`} disabled={busy || !valid || mine.hand[s] === 0} onClick={() => send(SIDE_ASK)}>
        Offer
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ tape

/** One print: bell-clock time, suit and price, seller circle to buyer circle. */
function PrintRow({ p, t, me, className }: { p: TradePrint; t: TableState; me: string; className?: string }) {
  const at = fmtClock(t.tradeEndTs - p.unixTs);
  return (
    <li className={className}>
      <span className="print-time num" aria-label={`${at} before the bell`}>
        {at}
      </span>
      <span className={`print-px s${p.suit}`}>
        <Suit s={p.suit} /> <span className="num">{p.price}</span>
      </span>
      <span className="print-who">
        <Seat seat={p.seller} kind={seatKind(t, p.seller, me)} />
        <span className="print-to">to</span>
        <Seat seat={p.buyer} kind={seatKind(t, p.buyer, me)} />
      </span>
    </li>
  );
}

function Tape({ t, mySeat, me }: { t: TableState; mySeat: number; me: string }) {
  const [all, setAll] = useState(false);
  const prints = roundTape(t)
    .map((p, k) => ({ p, k }))
    .reverse();
  const shown = all ? prints : prints.slice(0, TAPE_SHORT);
  return (
    <section className="tape" aria-label="Trades this round" data-testid="tape">
      <div className="sec-head">
        <h2>Tape</h2>
        <p>{prints.length ? "Newest first: clock, price, seller to buyer." : null}</p>
      </div>
      {prints.length === 0 ? <p className="empty">No trades yet. Quote a price or take one from the book.</p> : null}
      <ol className="prints">
        {shown.map(({ p, k }) => (
          <PrintRow key={`${p.slot}-${k}`} p={p} t={t} me={me} className={p.buyer === mySeat || p.seller === mySeat ? "print-mine" : ""} />
        ))}
      </ol>
      {prints.length > TAPE_SHORT ? (
        <button className="linkish" onClick={() => setAll((x) => !x)}>
          {all ? "Show the newest only" : `Show all ${prints.length} trades`}
        </button>
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------------ seats (who is here and what they quote)

function Seats({ t, me, mySeat }: { t: TableState; me: string; mySeat: number }) {
  const trading = t.phase === "trading";
  return (
    <section className="seats" aria-label="Table">
      <div className="sec-head">
        <h2>Table</h2>
        <p>{trading ? "A line is a trade. Its dot is the buyer." : null}</p>
      </div>
      <Felt t={t} me={me} mySeat={mySeat} />
      <ul className="seat-legend">
        {(["you", "player", "bot"] as const).map((kind) => {
          const seats = [0, 1, 2, 3].filter((i) => seatKind(t, i, me) === kind);
          if (!seats.length) return null;
          return (
            <li key={kind} className={kind === "you" ? "is-me" : ""}>
              {seats.map((i) => (
                <Seat key={i} seat={i} kind={kind} />
              ))}
              <span>{kind === "you" ? "You" : kind === "player" ? (seats.length > 1 ? "Players" : "Player") : seats.length > 1 ? "House bots" : "House bot"}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The table from above, in a 400 by 280 box: one circle, a seat at its bottom, left, top and right. */
const FELT = { w: 400, h: 280, cx: 200, cy: 140 };
const FELT_AT = [
  { x: 200, y: 228, qx: 200, qy: 263, side: "bottom" },
  { x: 112, y: 140, qx: 92, qy: 140, side: "left" },
  { x: 200, y: 52, qx: 200, qy: 17, side: "top" },
  { x: 288, y: 140, qx: 308, qy: 140, side: "right" },
];
/** How far the nth trade between the same two seats bows away from the straight line, so repeats fan out. */
const BOW_ACROSS = [12, -12, 34, -34, 56];
const BOW_CORNER = [0, 19, -16, 37, 52];
const at = (x: number, y: number): CSSProperties => ({ left: `${(x / FELT.w) * 100}%`, top: `${(y / FELT.h) * 100}%` });

/**
 * You sit at the bottom (seat 1 when watching). Each seat shows its live quotes, and every trade of the round
 * is a suit-coloured line from seller to buyer: the newest is the strongest, older ones fade. `upto` replays
 * the round up to that print.
 */
function Felt({ t, me, mySeat, upto }: { t: TableState; me: string; mySeat: number; upto?: number }) {
  const base = mySeat >= 0 ? mySeat : 0;
  const spot = (i: number) => FELT_AT[(i - base + 4) % 4];
  const prints = roundTape(t);
  const last = upto === undefined || upto < 0 ? prints.length - 1 : Math.min(upto, prints.length - 1);
  const nth: Record<string, number> = {};
  const taken: { x: number; y: number }[] = [];
  const lines = prints.map((p, k) => {
    const lo = spot(Math.min(p.seller, p.buyer));
    const hi = spot(Math.max(p.seller, p.buyer));
    const pair = `${Math.min(p.seller, p.buyer)}-${Math.max(p.seller, p.buyer)}`;
    const n = (nth[pair] = (nth[pair] ?? -1) + 1);
    const len = Math.hypot(hi.x - lo.x, hi.y - lo.y) || 1;
    // unit normal of the seat-to-seat line, turned towards the table's centre when the line is a corner chord
    let nx = -(hi.y - lo.y) / len;
    let ny = (hi.x - lo.x) / len;
    const mx = (lo.x + hi.x) / 2;
    const my = (lo.y + hi.y) / 2;
    const across = Math.hypot(mx - FELT.cx, my - FELT.cy) < 1;
    if (!across && nx * (FELT.cx - mx) + ny * (FELT.cy - my) < 0) {
      nx = -nx;
      ny = -ny;
    }
    const bow = (across ? BOW_ACROSS : BOW_CORNER)[n % 5];
    const from = spot(p.seller);
    const to = spot(p.buyer);
    const ux = (to.x - from.x) / len;
    const uy = (to.y - from.y) / len;
    const x1 = from.x + ux * 19;
    const y1 = from.y + uy * 19;
    const x2 = to.x - ux * 21;
    const y2 = to.y - uy * 21;
    const cx = mx + nx * bow * 2;
    const cy = my + ny * bow * 2;
    // The price sits at the line's midpoint; if an earlier print's price is already there it slides along
    // the line. Earlier prints never move for later ones, so a label keeps its place for the whole round.
    let lx = 0;
    let ly = 0;
    for (const f of [0.5, 0.34, 0.66, 0.22, 0.78]) {
      lx = (1 - f) * (1 - f) * x1 + 2 * (1 - f) * f * cx + f * f * x2;
      ly = (1 - f) * (1 - f) * y1 + 2 * (1 - f) * f * cy + f * f * y2;
      if (!taken.some((q) => Math.abs(q.x - lx) < 27 && Math.abs(q.y - ly) < 19)) break;
    }
    taken.push({ x: lx, y: ly });
    const age = last - k;
    return {
      p,
      key: `${p.slot}-${k}`,
      d: `M${x1.toFixed(1)} ${y1.toFixed(1)}Q${cx.toFixed(1)} ${cy.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`,
      x2,
      y2,
      lx,
      ly,
      age,
      opacity: age < 0 ? 0 : age === 0 ? 1 : Math.max(0.25, 0.85 - age * 0.15),
    };
  });
  return (
    <div className="felt" role="group" aria-label="The table from above">
      <svg viewBox={`0 0 ${FELT.w} ${FELT.h}`} aria-hidden="true" focusable="false">
        <circle className="felt-top" cx={FELT.cx} cy={FELT.cy} r="88" />
        {lines.map((l) => (
          <g key={l.key} className={`trade s${l.p.suit} ${l.age === 0 ? "is-newest" : ""}`} style={{ opacity: l.opacity }}>
            <path d={l.d} />
            <circle cx={l.x2} cy={l.y2} r="3.2" />
          </g>
        ))}
      </svg>
      {lines
        .filter((l) => l.age >= 0 && l.age < FELT_LABELS)
        .map((l) => (
          <span key={l.key} className={`trade-px num s${l.p.suit}`} style={at(l.lx, l.ly)} aria-hidden="true">
            {l.p.price}
          </span>
        ))}
      {t.seats.map((_, i) => {
        const s = spot(i);
        const quotes = t.phase === "trading" ? [0, 1, 2, 3].map((suit) => ({ suit, q: quoteText(t.bids[suit][i], t.asks[suit][i]) })).filter((x) => x.q) : [];
        return (
          <div key={i} className="felt-seat-group" role="group" aria-label={`Seat ${i + 1}`}>
            <span className="felt-seat" style={at(s.x, s.y)}>
              <Seat seat={i} kind={seatKind(t, i, me)} />
            </span>
            {quotes.length ? (
              <span className={`felt-quotes is-${s.side}`} style={at(s.qx, s.qy)}>
                {quotes.map(({ suit, q }) => (
                  <span key={suit} className={`s${suit}`} title={`${SUIT_MANY[suit]}: bid ${t.bids[suit][i] || "none"}, offer ${t.asks[suit][i] || "none"}`}>
                    <Suit s={suit} />
                    <Tick v={q} className="num" />
                  </span>
                ))}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ after the bell

function Hands({ t, me, mySeat, reveal }: { t: TableState; me: string; mySeat: number; reveal: (SeatState | null)[] | null }) {
  return (
    <section className="hands" aria-label="Hands at the bell">
      <div className="sec-head">
        <h2>Hands at the bell</h2>
        <p>Raised cards count towards the order.</p>
      </div>
      <ol className="hand-rows">
        {[0, 1, 2, 3].map((i) => {
          const s = reveal?.[i] ?? null;
          const kind = seatKind(t, i, me);
          const need = s ? orderRequirement(s.order) : [0, 0, 0, 0];
          const gaps = s ? need.map((n, k) => ({ k, gap: n - s.hand[k] })).filter((x) => x.gap > 0) : [];
          // face down until the seat opens: eight backs, as dealt; then the real hand, sorted by suit
          const cards: ({ k: number; counted: boolean; lead: boolean } | null)[] = s
            ? s.hand.flatMap((n, k) => Array.from({ length: n }, (_, j) => ({ k, counted: j < need[k], lead: j === 0 })))
            : Array.from({ length: 8 }, () => null);
          return (
            <li key={i} className={`card-flip ${s ? "is-open" : ""} ${i === mySeat ? "is-me" : ""}`} style={{ "--d": `${i * 90}ms` } as CSSProperties} data-testid="revealed-seat">
              <span className="hr-who">
                <Seat seat={i} kind={kind} />
                <span>{kind === "you" ? "You" : kind === "player" ? "Player" : "House bot"}</span>
              </span>
              <span className={`hr-cards ${cards.length > 10 ? "is-tight" : ""}`} aria-hidden="true">
                {cards.map((c, j) => (
                  <span key={j} className={`pc pc-flip ${c ? `s${c.k}` : ""} ${c?.counted ? "is-counted" : ""} ${c?.lead && j ? "is-lead" : ""}`} style={{ "--i": j } as CSSProperties}>
                    <span className="pc-turn">
                      <span className="pc-face">{c ? <Pip s={c.k} className="pc-mid" /> : null}</span>
                      <span className="pc-back" />
                    </span>
                  </span>
                ))}
              </span>
              {s ? (
                <span className="hr-text">
                  <span className="hr-order num" aria-label="Order">
                    {s.order.qtyA} <Suit s={s.order.suitA} /> + {s.order.qtyB} <Suit s={s.order.suitB} />
                  </span>
                  <span className="sr-only">Hand at the bell: {s.hand.map((n, k) => `${n} ${n === 1 ? SUIT_ONE[k] : SUIT_MANY[k]}`).join(", ")}.</span>
                  <span className={`hr-verdict ${t.filled[i] ? "is-filled" : ""}`}>
                    {t.filled[i] ? (
                      "Filled"
                    ) : gaps.length ? (
                      <>
                        Missed by{" "}
                        {gaps.map((g, n) => (
                          <span key={g.k}>
                            {n ? ", " : ""}
                            {g.gap} <Suit s={g.k} />
                          </span>
                        ))}
                      </>
                    ) : (
                      "Missed"
                    )}
                  </span>
                  <span className="hr-chips">
                    <span className="num">{s.chips}</span> chips
                  </span>
                </span>
              ) : (
                <span className="hr-wait">Opening…</span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Scoreboard({ t, mySeat, me }: { t: TableState; mySeat: number; me: string }) {
  const order = [0, 1, 2, 3].sort((a, b) => t.ranks[a] - t.ranks[b]);
  return (
    <section className="scores" aria-label="Scoreboard">
      <div className="sec-head">
        <h2>Scoreboard</h2>
        <p>Chips, plus 100 for a filled order.</p>
      </div>
      <ol className="score-rows" data-testid="scoreboard">
        {order.map((i) => {
          const chips = t.scores[i] - (t.filled[i] ? BONUS : 0);
          const kind = seatKind(t, i, me);
          return (
            <li key={i} className={`score ${i === mySeat ? "score-me" : ""}`}>
              <span className="score-rank num" aria-label={ordinal(t.ranks[i] + 1)}>
                {t.ranks[i] + 1}
              </span>
              <span className="score-who">
                <Seat seat={i} kind={kind} />
                <span>{kind === "you" ? "You" : kind === "player" ? "Player" : "House bot"}</span>
              </span>
              <span className="score-calc">{t.filled[i] ? `${chips} chips + 100 for the filled order` : `${chips} chips, order missed`}</span>
              <span className="score-pts num">{t.scores[i]}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function TapeReplay({ t, me, mySeat }: { t: TableState; me: string; mySeat: number }) {
  const prints = roundTape(t);
  const [step, setStep] = useState(-1);
  useEffect(() => {
    if (step < 0 || step >= prints.length) return;
    const id = setTimeout(() => setStep((x) => (x + 1 >= prints.length ? -1 : x + 1)), 650);
    return () => clearTimeout(id);
  }, [step, prints.length]);
  return (
    <section className="tape replay" aria-label="Round tape">
      <div className="sec-head">
        <h2>
          Tape, {prints.length} {prints.length === 1 ? "trade" : "trades"}
        </h2>
        {prints.length ? (
          <button className="linkish" onClick={() => setStep(0)}>
            {step >= 0 ? "Replaying…" : "Replay in order"}
          </button>
        ) : null}
      </div>
      <Felt t={t} me={me} mySeat={mySeat} upto={step} />
      {prints.length === 0 ? <p className="empty">Nobody traded this round.</p> : null}
      <ol className={`prints ${step >= 0 ? "is-replaying" : ""}`}>
        {prints.map((p, k) => (
          <PrintRow key={`${p.slot}-${k}`} p={p} t={t} me={me} className={k === step ? "on" : k < step ? "past" : ""} />
        ))}
      </ol>
    </section>
  );
}

function PrivacyStory({ t, tablePk, probe, mySeat, walletAddr }: { t: TableState; tablePk: PublicKey; probe: { seat: number; at: number; hidden: boolean } | null; mySeat: number; walletAddr: string | null }) {
  const log = useTxLog();
  const [flips, setFlips] = useState<act.RoundTxs | null>(null);
  useEffect(() => {
    setFlips(null);
    act.findRoundTxs(tablePk, t).then(setFlips);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tablePk, t.round]);
  const mine = log.filter((e: TxEntry) => e.table === tablePk.toBase58() && e.round === t.round);
  const startTx = mine.find((e) => /start round|join seat .* \+ start/.test(e.label));
  const trades = mine.filter((e) => /^(buy|sell|bid|offer|cancel)/.test(e.label));
  const publish = mine.find((e) => e.label.startsWith("publish"));
  const recordAddr = walletAddr && mySeat >= 0 && t.seats[mySeat].wallet.toBase58() === walletAddr ? act.myRecordAddress() : null;
  const pending = <span className="quiet">{flips ? "Not found on the rollup." : "Looking it up…"}</span>;
  return (
    <section className="story" aria-label="What was private and when it flipped">
      <h2>What was private, and when it turned public</h2>
      <div className="cols">
        <ol className="timeline col-main">
          <li>
            <h3>Seats sealed</h3>
            <p>
              Starting the round made each seat private on the TEE rollup: only its owner’s signed-in key can read it. Bot
              seats have no player reader. When the house dealer starts a round, its key sits in one seat just long enough to
              deal and stays that seat’s only reader.
            </p>
          </li>
          <li>
            <h3>Cards dealt in the dark</h3>
            <p>
              A VRF callback shuffled the deck and wrote eight cards, 200 chips and a secret order into each sealed seat. The
              TEE hid that transaction from everyone while the round ran, because its randomness decides every hand. Now that
              the hands are public, it is readable too.
            </p>
          </li>
          <li>
            <h3>Trading</h3>
            <p>
              Prices and trades were public on the table account. Hands and orders were not.
              {probe ? (
                <>
                  {" "}
                  At {new Date(probe.at).toLocaleTimeString()} this page tried to read seat {probe.seat + 1} with your key and found it{" "}
                  <b>{probe.hidden ? "hidden" : "visible, which was not expected"}</b>.
                </>
              ) : null}
            </p>
          </li>
          <li>
            <h3>The bell turned everything public</h3>
            <p>Ringing the bell scored the round and set all four seats public, so anyone can now read every hand and order at the table.</p>
          </li>
          <li>
            <h3>Results went to Solana</h3>
            <p>
              <code>publish_records</code> scheduled a Magic Action that updates wallet-bound player records on the devnet base
              layer{t.recordsRound >= t.round ? "" : " (pending)"}.
            </p>
          </li>
        </ol>

        <div className="receipts col-side">
          <h3>Receipts for round {t.round}</h3>
          <dl className="receipt-rows">
            <div>
              <dt>Seats sealed</dt>
              <dd>{startTx ? <TxLink sig={startTx.sig} layer="er">your start transaction</TxLink> : flips?.seal ? <TxLink sig={flips.seal} layer="er">seal transaction</TxLink> : pending}</dd>
            </div>
            <div>
              <dt>Dealt</dt>
              <dd>{flips?.deal ? <TxLink sig={flips.deal} layer="er">deal transaction</TxLink> : pending}</dd>
            </div>
            <div>
              <dt>Your actions</dt>
              <dd>
                {trades.length ? (
                  trades.slice(0, 6).map((e) => (
                    <TxLink key={e.sig} sig={e.sig} layer="er">
                      {txLabel(e.label)}
                    </TxLink>
                  ))
                ) : (
                  <span className="quiet">{mySeat >= 0 ? "None this round." : "You watched this round."}</span>
                )}
              </dd>
            </div>
            <div>
              <dt>Bell</dt>
              <dd>{flips?.bell ? <TxLink sig={flips.bell} layer="er">bell transaction (rung by the crank)</TxLink> : <span className="quiet">The on-chain crank rang it.</span>}</dd>
            </div>
            <div>
              <dt>Results</dt>
              <dd>
                {publish ? <TxLink sig={publish.sig} layer="er">publish transaction</TxLink> : null}
                {recordAddr ? <AddrLink addr={recordAddr} layer="base">your player record</AddrLink> : <span className="quiet">Seats without a bound wallet are skipped.</span>}
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  );
}

function MyTxs({ address, round }: { address: string; round: number }) {
  const log = useTxLog().filter((e) => e.table === address && (e.round ?? 0) >= round - 1);
  if (!log.length) return null;
  return (
    <details className="mytx">
      <summary>Your transactions at this table ({log.length})</summary>
      <ul>
        {log.map((e) => (
          <li key={e.sig}>
            <span className="quiet">Round {e.round}</span> {txLabel(e.label)} <TxLink sig={e.sig} layer={e.layer} />
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Phone only: clock, order progress and chips pinned to the bottom edge once the big clock scrolls away. */
function Cockpit({ t, mine, now }: { t: TableState; mine: SeatState; now: number }) {
  const need = orderRequirement(mine.order);
  const left = t.tradeEndTs - now;
  const [clockInView, setClockInView] = useState(true);
  useEffect(() => {
    const clock = document.querySelector('[data-testid="bell-clock"]');
    if (!clock || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setClockInView(e.isIntersecting), { threshold: 0 });
    io.observe(clock);
    return () => io.disconnect();
  }, []);
  return (
    <aside className={`cockpit ${clockInView ? "is-tucked" : ""} ${left < 10 ? "is-late" : ""}`} aria-label="Your round at a glance">
      <span className="ck-clock num" aria-label={`${fmtClock(left)} until the bell`}>
        {fmtClock(left)}
      </span>
      <span className="ck-held" aria-label="Held of each suit you need">
        {[0, 1, 2, 3]
          .filter((s) => need[s] > 0)
          .map((s) => (
            <span key={s} className={mine.hand[s] >= need[s] ? "is-ok" : ""}>
              <Suit s={s} />
              <span className="num">
                {mine.hand[s]}/{need[s]}
              </span>
            </span>
          ))}
      </span>
      <span className="ck-chips">
        <b className="num">{mine.chips}</b> chips
      </span>
      <span className="ck-drain" style={{ transform: `scaleX(${Math.max(0, Math.min(1, left / t.windowSecs))})` }} aria-hidden="true" />
    </aside>
  );
}

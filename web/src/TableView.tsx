import { useEffect, useMemo, useRef, useState } from "react";
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
import { Pit, roundTape } from "./Pit";
import bellImg from "./assets/img/bell.webp";
import { AddrLink, JACKETS, Jacket, JacketPortrait, SeatSquare, Suit, Tick, TxLink, fmtClock, go, ordinal, toast } from "./ui";

const BONUS = 100;

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
        toast("ok", `Seated in the ${JACKETS[s].name} jacket. Dealing.${bound}`, r.sig);
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
    // Skeleton: the empty pit and a blank board, so the page keeps its shape while the rollup answers.
    return (
      <main className="table-page" data-phase="loading">
        <TableHeader name={house?.name ?? address.slice(0, 6)} address={address} />
        <section className="board board-skeleton" aria-hidden="true">
          <ol className="board-cols">
            {[0, 1, 2, 3].map((s) => (
              <li key={s} className="board-col">
                <span className="board-suit">
                  <Suit s={s} withName />
                </span>
              </li>
            ))}
          </ol>
        </section>
        <div className="floor container">
          <div className="floor-pit">
            <Pit t={null} now={now} mySeat={-1} me={me} />
          </div>
          <div className="floor-rail">
            <p className={`status-note ${error ? "is-bad" : ""}`}>
              {error ? `This table could not be read from the rollup: ${error}` : "Reading the table from the rollup…"}
            </p>
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

  const front = (
    <>
      {t.phase === "trading" && mySeat >= 0 ? <Ticket seatIndex={mySeat} mine={mine} t={t} /> : null}
      {mySeat < 0 ? <SeatBar t={t} now={now} wantSeat={wantSeat} busy={busy} onSit={() => setWantSeat(true)} /> : null}
      {busy ? (
        <p className="busy" data-testid="busy">
          {busy}
        </p>
      ) : null}
    </>
  );

  return (
    <main className="table-page" data-phase={t.phase}>
      <TableHeader name={house?.name ?? address.slice(0, 6)} address={address} round={t.round} source={source} />

      {t.phase === "settled" ? <Scoreboard t={t} mySeat={mySeat} me={me} /> : <PriceBoard t={t} />}

      <div className="floor container">
        {t.phase === "settled" ? (
          <section className="reveal floor-top" data-testid="reveal">
            <img className="reveal-bell" src={bellImg} alt="" width={640} height={640} />
            <h2>Bell. Round {t.round} is over.</h2>
            <p className="reveal-sub">Every hand is face up on the steps. Scores are on the board.</p>
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
          </section>
        ) : null}

        <div className="floor-pit">
          <Pit t={t} now={now} mySeat={mySeat} me={me} reveal={reveal} front={front} />
        </div>

        <div className="floor-rail">
          {t.phase === "trading" ? (
            <>
              <Book t={t} mySeat={mySeat} mine={mine} busy={!!busy} run={run} tablePk={tablePk} />
              <Tape t={t} mySeat={mySeat} />
            </>
          ) : null}
          {t.phase === "dealing" ? (
            <p className="status-note">
              Shuffling with verifiable randomness. The deal lands straight into sealed seats, so nobody sees a hand but its owner.
            </p>
          ) : null}
          {t.phase === "lobby" ? <p className="status-note">No round has been dealt here yet. Take a seat to deal the first one.</p> : null}
          {t.phase === "settled" ? <TapeReplay prints={roundTape(t)} /> : null}
        </div>
      </div>

      {t.phase === "settled" ? (
        <div className="container">
          <PrivacyStory t={t} tablePk={tablePk} probe={privacyProbe?.round === t.round ? privacyProbe : null} mySeat={mySeat} walletAddr={wallet.account?.address ?? null} />
        </div>
      ) : null}

      <div className="container table-foot">
        {mySeat >= 0 && t.phase !== "settled" ? (
          <p className="seat-foot">
            You are in the <Jacket seat={mySeat} /> jacket.{" "}
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

      {t.phase === "trading" && mySeat >= 0 && mine ? <Cockpit t={t} mine={mine} seatIndex={mySeat} now={now} /> : null}
    </main>
  );
}

/** Phone only: the decision loop pinned to the bottom edge while the book scrolls. */
function Cockpit({ t, mine, seatIndex, now }: { t: TableState; mine: SeatState; seatIndex: number; now: number }) {
  const need = orderRequirement(mine.order);
  const left = t.tradeEndTs - now;
  // While your card is on screen the bar would only repeat it, so it tucks away.
  const [cardInView, setCardInView] = useState(true);
  useEffect(() => {
    const card = document.querySelector('[data-testid="my-ticket"]');
    if (!card || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setCardInView(e.intersectionRatio >= 0.15), { threshold: [0, 0.15, 0.5] });
    io.observe(card);
    return () => io.disconnect();
  }, []);
  return (
    <aside className={`cockpit ${JACKETS[seatIndex].cls} ${cardInView ? "is-tucked" : ""}`} aria-label="Your round at a glance">
      <span className="ck-order">
        {mine.order.qtyA} <Suit s={mine.order.suitA} /> + {mine.order.qtyB} <Suit s={mine.order.suitB} />
      </span>
      <span className="ck-held" aria-label="Held of each suit you need">
        {[0, 1, 2, 3]
          .filter((s) => need[s] > 0)
          .map((s) => (
            <span key={s} className={mine.hand[s] >= need[s] ? "is-ok" : ""}>
              <Suit s={s} />
              <b className="num">
                {mine.hand[s]}/{need[s]}
              </b>
            </span>
          ))}
      </span>
      <span className="ck-chips">
        <b className="num">{mine.chips}</b> chips
      </span>
      <span className={`ck-clock ${left < 10 ? "is-late" : ""}`} aria-label={`${fmtClock(left)} until the bell`}>
        {fmtClock(left)}
      </span>
    </aside>
  );
}

function TableHeader({ name, address, round, source }: { name: string; address: string; round?: number; source?: string }) {
  return (
    <header className="table-head container">
      <a className="back" href="#/">
        Lobby
      </a>
      <h1>
        {name}
        {round !== undefined ? (
          <span className="round">
            {" "}
            round <Tick v={round} />
          </span>
        ) : null}
      </h1>
      <span className="head-meta">
        <AddrLink addr={address} layer="er">
          Table account
        </AddrLink>
        {source ? <span className="live">{source === "ws" ? "Live updates" : "Polling for updates"}</span> : null}
      </span>
    </header>
  );
}

// ------------------------------------------------------------------ the price board (dark strip)

function PriceBoard({ t }: { t: TableState }) {
  const prints = roundTape(t);
  return (
    <section className="board" aria-label="Price board">
      <ol className="board-cols">
        {[0, 1, 2, 3].map((s) => {
          const bid = t.phase === "trading" ? bestBid(t, s) : null;
          const ask = t.phase === "trading" ? bestAsk(t, s) : null;
          const last = [...prints].reverse().find((p) => p.suit === s);
          return (
            <li key={s} className="board-col">
              <span className="board-suit">
                <Suit s={s} withName />
              </span>
              <span className="board-cell">
                <span className="board-lab">Bid</span>
                <span className="board-num">{bid ? <Tick v={bid.price} /> : "––"}</span>
                <span className="board-who">{bid ? <SeatSquare seat={bid.seat} /> :" "}</span>
              </span>
              <span className="board-cell">
                <span className="board-lab">Offer</span>
                <span className="board-num">{ask ? <Tick v={ask.price} /> : "––"}</span>
                <span className="board-who">{ask ? <SeatSquare seat={ask.seat} /> :" "}</span>
              </span>
              <span className="board-cell board-last">
                <span className="board-lab">Last</span>
                <span className="board-num">{last ? <Tick v={last.price} /> : "––"}</span>
                <span className="board-who">{last ? (
                    <>
                      <SeatSquare seat={last.seller} />
                      <span className="board-to">to</span>
                      <SeatSquare seat={last.buyer} />
                    </>
                  ) :" "}</span>
              </span>
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
    <section className="board board-scores" aria-label="Scoreboard">
      <ol className="board-cols" data-testid="scoreboard">
        {order.map((i) => {
          const chips = t.scores[i] - (t.filled[i] ? BONUS : 0);
          const who = t.seats[i].kind === "human" ? (t.seats[i].owner.toBase58() === me ? "you" : "player") : "house bot";
          return (
            <li key={i} className={`board-col score ${i === mySeat ? "score-me" : ""}`}>
              <span className="score-rank" aria-label={ordinal(t.ranks[i] + 1)}>
                {t.ranks[i] + 1}
              </span>
              <span className="score-who">
                <b>{JACKETS[i].name}</b> {who}
              </span>
              <JacketPortrait seat={i} className="score-portrait" />
              <span className="board-num score-pts">{t.scores[i]}</span>
              <span className="score-calc">{t.filled[i] ? `${chips} chips + 100 for the filled order` : `${chips} chips, order missed`}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function SeatBar({ t, now, wantSeat, busy, onSit }: { t: TableState; now: number; wantSeat: boolean; busy: string | null; onSit: () => void }) {
  const free = freeSeats(t);
  if (free.length === 0) return <p className="slip seatbar">Every seat here is taken by a player. Watch, or pick another table in the lobby.</p>;
  if (canJoin(t)) {
    return (
      <div className="slip seatbar">
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
    <div className="slip seatbar">
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

// ------------------------------------------------------------------ my trading card

function Ticket({ seatIndex, mine, t }: { seatIndex: number; mine: SeatState | null; t: TableState }) {
  if (!mine) {
    return (
      <section className={`ticket is-loading ${JACKETS[seatIndex].cls}`} data-testid="my-ticket">
        <p className="ticket-wait">Reading your sealed seat with your key…</p>
      </section>
    );
  }
  const need = orderRequirement(mine.order);
  const filled = orderFilled(mine);
  return (
    <section className={`ticket ${JACKETS[seatIndex].cls}`} data-testid="my-ticket" aria-label="Your private hand and order">
      <div className="ticket-top">
        <Jacket seat={seatIndex} label={`${JACKETS[seatIndex].name}, you`} />
        <span className="stamp">only you can see this</span>
      </div>
      <p className="ticket-order">
        <span className="ticket-lab">Your order</span>
        <span className="pencil-big" data-testid="my-order">
          {mine.order.qtyA} <Suit s={mine.order.suitA} /> + {mine.order.qtyB} <Suit s={mine.order.suitB} />
        </span>
      </p>
      <div className="hand" data-testid="my-hand">
        {mine.hand.map((n, s) => {
          const short = need[s] - n;
          return (
            <div key={s} className={`hold ${need[s] ? (short > 0 ? "hold-short" : "hold-ok") : "hold-spare"}`}>
              <Suit s={s} />
              <Tick v={n} className="hold-n" />
              <span className="hold-note">{need[s] ? (short > 0 ? `need ${short}` : "covered") : n ? "spare" : " "}</span>
            </div>
          );
        })}
      </div>
      <div className="ticket-foot">
        <span>
          <b className="num" data-testid="my-chips">
            <Tick v={mine.chips} />
          </b>{" "}
          chips
        </span>
        <span>
          If the bell rang now: <b className="num">{mine.chips + (filled ? BONUS : 0)}</b>
          {filled ? ", order filled (+100)" : ", order not filled"}
        </span>
      </div>
      <p className="ticket-help">
        Score is chips, plus 100 if you hold your whole order at the bell. Sell spares, buy what you need. Round {t.round}.
      </p>
    </section>
  );
}

// ------------------------------------------------------------------ the book (one ruled sheet)

type Run = (label: string, f: () => Promise<act.ActionResult>, okText?: string) => Promise<act.ActionResult>;

function Book({ t, mySeat, mine, busy, run, tablePk }: { t: TableState; mySeat: number; mine: SeatState | null; busy: boolean; run: Run; tablePk: PublicKey }) {
  const need = mine ? orderRequirement(mine.order) : [0, 0, 0, 0];
  const seated = mySeat >= 0 && !!mine;
  return (
    <section className={`sheet book ${mySeat >= 0 ? JACKETS[mySeat].cls : ""}`} aria-label="Order book" data-testid="book">
      <h2 className="sheet-title">Book</h2>
      <p className="sheet-sub">{seated ? "Take the best price, or write your own." : "Best prices from the other seats. Take a seat to trade."}</p>
      {[0, 1, 2, 3].map((s) => {
        const bid = bestBid(t, s, mySeat);
        const ask = bestAsk(t, s, mySeat);
        const want = need[s] - (mine?.hand[s] ?? 0);
        return (
          <div className={`book-row ${want > 0 ? "row-want" : ""}`} key={s} data-testid={`book-row-${s}`}>
            <div className="book-suit">
              <Suit s={s} withName />
              {seated ? <span className="book-need">{want > 0 ? `need ${want}` : mine!.hand[s] > 0 ? `${mine!.hand[s]} held` : "none held"}</span> : null}
            </div>
            <div className="book-take">
              <button
                className="btn btn-line take"
                data-testid={`sell-${s}`}
                disabled={!seated || !bid || busy}
                title={bid ? `Sell one ${["spade", "club", "heart", "diamond"][s]} to ${JACKETS[bid.seat].name} at ${bid.price}` : "No bid"}
                onClick={() => bid && run("Selling…", () => act.take(tablePk, mySeat, s, SIDE_BID, bid.seat, bid.price), `Sold 1 at ${bid.price}.`)}
              >
                <span>Sell</span>
                <span className="take-px num">{bid ? <Tick v={bid.price} /> : "–"}</span>
                {bid ? <span className={`take-who ${JACKETS[bid.seat].cls}`}>{bid.seat + 1}</span> : null}
              </button>
              <button
                className="btn btn-fill take"
                data-testid={`buy-${s}`}
                disabled={!seated || !ask || busy}
                title={ask ? `Buy one from ${JACKETS[ask.seat].name} at ${ask.price}` : "No offer"}
                onClick={() => ask && run("Buying…", () => act.take(tablePk, mySeat, s, SIDE_ASK, ask.seat, ask.price), `Bought 1 at ${ask.price}.`)}
              >
                <span>Buy</span>
                <span className="take-px num">{ask ? <Tick v={ask.price} /> : "–"}</span>
                {ask ? <span className={`take-who ${JACKETS[ask.seat].cls}`}>{ask.seat + 1}</span> : null}
              </button>
            </div>
            {seated ? <QuoteBox t={t} s={s} mySeat={mySeat} mine={mine!} want={want} busy={busy} run={run} tablePk={tablePk} /> : null}
          </div>
        );
      })}
      {!seated && mySeat < 0 ? <p className="sheet-foot">Each seat’s own quotes are pencilled on the tab beside its badge in the pit.</p> : null}
    </section>
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
    <div className="quotebox">
      <label className="sr-only" htmlFor={`px-${s}`}>
        Price for {["spades", "clubs", "hearts", "diamonds"][s]}
      </label>
      <input id={`px-${s}`} className="px" inputMode="numeric" value={px} data-testid={`px-${s}`} onChange={(e) => setPx(e.target.value.replace(/[^0-9]/g, "").slice(0, 2))} />
      <button className="btn btn-fill btn-small" data-testid={`bid-${s}`} disabled={busy || !valid || mine.chips < price} onClick={() => send(SIDE_BID)}>
        Bid
      </button>
      <button className="btn btn-line btn-small" data-testid={`offer-${s}`} disabled={busy || !valid || mine.hand[s] === 0} onClick={() => send(SIDE_ASK)}>
        Offer
      </button>
      {myBid || myAsk ? (
        <span className="myquotes">
          {myBid ? (
            <button className="chip" aria-label={`Cancel my bid at ${myBid}`} title="Cancel my bid" onClick={() => run("Cancelling…", () => act.cancel(tablePk, t, mySeat, s, SIDE_BID), "Bid cancelled.")}>
              bid {myBid} <span aria-hidden="true">×</span>
            </button>
          ) : null}
          {myAsk ? (
            <button className="chip" aria-label={`Cancel my offer at ${myAsk}`} title="Cancel my offer" onClick={() => run("Cancelling…", () => act.cancel(tablePk, t, mySeat, s, SIDE_ASK), "Offer cancelled.")}>
              offer {myAsk} <span aria-hidden="true">×</span>
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ tape (text twin of the arcs)

function Tape({ t, mySeat }: { t: TableState; mySeat: number }) {
  const all = roundTape(t);
  const prints = all.map((p, k) => ({ p, k })).reverse();
  return (
    <section className="sheet tape" aria-label="Trades this round" data-testid="tape">
      <h2 className="sheet-title">Tape</h2>
      {prints.length === 0 ? <p className="empty">No trades yet. Quote a price or take one from the book.</p> : null}
      <ol className="prints">
        {prints.map(({ p, k }) => (
          <li key={`${p.slot}-${k}`} className={p.buyer === mySeat || p.seller === mySeat ? "print-mine" : ""}>
            <span className="print-px">
              <Suit s={p.suit} /> <span className="num">{p.price}</span>
            </span>
            <span className="print-who">
              {JACKETS[p.seller].name} sold to {JACKETS[p.buyer].name}
            </span>
            <span className="print-time num">{new Date(p.unixTs * 1000).toLocaleTimeString([], { minute: "2-digit", second: "2-digit" })}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ------------------------------------------------------------------ after the bell

function TapeReplay({ prints }: { prints: TradePrint[] }) {
  const [step, setStep] = useState(-1);
  useEffect(() => {
    if (step < 0 || step >= prints.length) return;
    const id = setTimeout(() => setStep((x) => (x + 1 >= prints.length ? -1 : x + 1)), 650);
    return () => clearTimeout(id);
  }, [step, prints.length]);
  return (
    <section className="sheet replay" aria-label="Round tape">
      <div className="replay-head">
        <h3 className="sheet-title">
          The tape, {prints.length} {prints.length === 1 ? "trade" : "trades"}
        </h3>
        {prints.length ? (
          <button className="btn btn-line btn-small" onClick={() => setStep(0)}>
            {step >= 0 ? "Replaying…" : "Replay"}
          </button>
        ) : null}
      </div>
      {prints.length === 0 ? <p className="empty">Nobody traded this round.</p> : null}
      <ol className="prints replay-list">
        {prints.map((p, k) => (
          <li key={k} className={k === step ? "on" : k < step ? "past" : ""}>
            <span className="print-px">
              <Suit s={p.suit} /> <span className="num">{p.price}</span>
            </span>
            <span className="print-who">
              {JACKETS[p.seller].name} sold to {JACKETS[p.buyer].name}
            </span>
          </li>
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
  return (
    <section className="story" aria-label="What was private and when it flipped">
      <h3>What was private, and when it turned public</h3>
      <div className="story-cols">
        <ol className="timeline">
          <li>
            <h4>Seats sealed</h4>
            <p>
              Starting the round made each seat private on the TEE rollup: only its owner’s signed-in key can read it. Bot
              seats have no player reader. When the house dealer starts a round, its key sits in one seat just long enough to
              deal and stays that seat’s only reader.
            </p>
          </li>
          <li>
            <h4>Cards dealt in the dark</h4>
            <p>
              A VRF callback shuffled the deck and wrote eight cards, 200 chips and a secret order into each sealed seat. The
              TEE hid that transaction from everyone while the round ran, because its randomness decides every hand. Now that
              the hands are public, it is readable too.
            </p>
          </li>
          <li>
            <h4>Trading</h4>
            <p>
              Prices and trades were public on the table account. Hands and orders were not.
              {probe ? (
                <>
                  {" "}
                  At {new Date(probe.at).toLocaleTimeString()} this page tried to read the <Jacket seat={probe.seat} /> seat with your key and found it{" "}
                  <b>{probe.hidden ? "hidden" : "visible, which was not expected"}</b>.
                </>
              ) : null}
            </p>
          </li>
          <li>
            <h4>The bell turned everything public</h4>
            <p>Ringing the bell scored the round and set all four seats public, so anyone can now read every hand and order in the pit.</p>
          </li>
          <li>
            <h4>Results went to Solana</h4>
            <p>
              <code>publish_records</code> scheduled a Magic Action that updates wallet-bound player records on the devnet base
              layer{t.recordsRound >= t.round ? "" : " (pending)"}.
            </p>
          </li>
        </ol>

        <div className="sheet receipts">
          <h4 className="receipts-title">Receipts for round {t.round}</h4>
          <ol className="receipt-rows">
            <li>
              <span className="rc-step">Seats sealed</span>
              <span className="rc-links">
                {startTx ? (
                  <TxLink sig={startTx.sig} layer="er">your start transaction</TxLink>
                ) : flips?.seal ? (
                  <TxLink sig={flips.seal} layer="er">seal transaction</TxLink>
                ) : (
                  <span className="muted">{flips ? "Not found on the rollup." : "Looking it up…"}</span>
                )}
              </span>
            </li>
            <li>
              <span className="rc-step">Dealt</span>
              <span className="rc-links">
                {flips?.deal ? <TxLink sig={flips.deal} layer="er">deal transaction</TxLink> : <span className="muted">{flips ? "Not found on the rollup." : "Looking it up…"}</span>}
              </span>
            </li>
            <li>
              <span className="rc-step">Your actions</span>
              <span className="rc-links">
                {trades.length ? (
                  trades.slice(0, 6).map((e) => (
                    <TxLink key={e.sig} sig={e.sig} layer="er">
                      {e.label}
                    </TxLink>
                  ))
                ) : (
                  <span className="muted">{mySeat >= 0 ? "None this round." : "You watched this round."}</span>
                )}
              </span>
            </li>
            <li>
              <span className="rc-step">Bell</span>
              <span className="rc-links">
                {flips?.bell ? <TxLink sig={flips.bell} layer="er">bell transaction (rung by the crank)</TxLink> : <span className="muted">The on-chain crank rang it.</span>}
              </span>
            </li>
            <li>
              <span className="rc-step">Results</span>
              <span className="rc-links">
                {publish ? <TxLink sig={publish.sig} layer="er">publish transaction</TxLink> : null}
                {recordAddr ? <AddrLink addr={recordAddr} layer="base">your player record</AddrLink> : <span className="muted">Seats without a bound wallet are skipped.</span>}
              </span>
            </li>
          </ol>
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
            <span className="muted">Round {e.round}</span> {e.label} <TxLink sig={e.sig} layer={e.layer} />
          </li>
        ))}
      </ul>
    </details>
  );
}

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
import { AddrLink, JACKETS, Jacket, Suit, TxLink, fmtClock, go, toast } from "./ui";

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
    return (
      <main className="table-page">
        <TableHeader name={house?.name ?? address.slice(0, 6)} address={address} />
        <p className="empty">{error ? `This table could not be read from the rollup: ${error}` : "Reading the table from the rollup…"}</p>
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

  return (
    <main className="table-page" data-phase={t.phase}>
      <TableHeader name={house?.name ?? address.slice(0, 6)} address={address} round={t.round} source={source} />

      {t.phase === "trading" || t.phase === "dealing" ? (
        <Bell t={t} now={now} />
      ) : null}

      {mySeat < 0 ? (
        <SeatBar t={t} now={now} wantSeat={wantSeat} busy={busy} onSit={() => setWantSeat(true)} />
      ) : null}
      {busy ? <p className="busy" data-testid="busy">{busy}</p> : null}

      {t.phase === "dealing" ? (
        <section className="dealing">
          <div className="shuffle" aria-hidden="true">
            <span>♠</span>
            <span>♣</span>
            <span>♥</span>
            <span>♦</span>
          </div>
          <p>Shuffling with verifiable randomness. The deal lands straight into sealed seats.</p>
        </section>
      ) : null}

      {t.phase === "trading" ? (
        <div className="pit">
          {mySeat >= 0 ? <Ticket seatIndex={mySeat} mine={mine} t={t} /> : null}
          <Board t={t} mySeat={mySeat} mine={mine} busy={!!busy} run={run} tablePk={tablePk} />
          <Tape t={t} mySeat={mySeat} />
        </div>
      ) : null}

      {t.phase === "settled" ? (
        <Reveal
          t={t}
          reveal={reveal}
          mySeat={mySeat}
          tablePk={tablePk}
          probe={privacyProbe?.round === t.round ? privacyProbe : null}
          walletAddr={wallet.account?.address ?? null}
          actions={
            mySeat >= 0 ? (
              <div className="after-actions">
                <button className="btn btn-bell" disabled={!!busy} data-testid="next-round" onClick={() => run("Dealing the next round…", () => act.startRound(tablePk, t), "Next round requested.")}>
                  Deal the next round
                </button>
                {wallet.account && t.seats[mySeat].wallet.toBase58() !== wallet.account.address ? (
                  <button className="btn btn-ghost" disabled={!!busy} onClick={() => run("Binding your wallet…", () => act.bindWallet(tablePk, t, mySeat), "Seat bound to your wallet.")}>
                    Bind seat to my wallet
                  </button>
                ) : null}
                <button
                  className="btn btn-ghost"
                  disabled={!!busy}
                  data-testid="leave"
                  onClick={async () => {
                    const r = await run("Leaving…", () => act.leave(tablePk, t, mySeat), "Seat handed back to the house bot.");
                    if (r.ok) go("/");
                  }}
                >
                  Leave the table
                </button>
              </div>
            ) : null
          }
        />
      ) : null}

      {t.phase === "lobby" ? <p className="empty">No round has been dealt here yet. Take a seat to deal the first one.</p> : null}

      {mySeat >= 0 && t.phase !== "settled" ? (
        <p className="seat-foot">
          You are in the <Jacket seat={mySeat} /> jacket.{" "}
          <button
            className="linkish"
            onClick={async () => {
              const r = await run("Leaving…", () => act.leave(tablePk, t, mySeat), "Seat handed back to the house bot.");
              if (r.ok) go("/");
            }}
          >
            Leave (a house bot finishes your hand)
          </button>
        </p>
      ) : null}
      <MyTxs address={address} round={t.round} />
      <p className="rpc-note">
        Table state streams from the TEE rollup at <code>{TEE_RPC.replace(/^https:\/\//, "")}</code>{" "}
        ({source === "ws" ? "live subscription" : "polling"}).
      </p>
    </main>
  );
}

function TableHeader({ name, address, round, source }: { name: string; address: string; round?: number; source?: string }) {
  return (
    <header className="table-head">
      <a className="back" href="#/">
        Lobby
      </a>
      <h1>
        {name}
        {round !== undefined ? <span className="round"> round {round}</span> : null}
      </h1>
      <AddrLink addr={address} layer="er">
        table account
      </AddrLink>
      {source ? <span className={`live live-${source}`} title={source === "ws" ? "Live subscription" : "Polling"} /> : null}
    </header>
  );
}

function Bell({ t, now }: { t: TableState; now: number }) {
  const left = t.phase === "trading" ? t.tradeEndTs - now : t.windowSecs;
  const frac = t.phase === "trading" ? Math.max(0, Math.min(1, left / t.windowSecs)) : 1;
  return (
    <div className={`bell ${left < 10 && t.phase === "trading" ? "bell-late" : ""}`} data-testid="bell-clock">
      <div className="bell-face">{t.phase === "trading" ? fmtClock(left) : "–:––"}</div>
      <div className="bell-bar" aria-hidden="true">
        <span style={{ transform: `scaleX(${frac})` }} />
      </div>
      <div className="bell-label">{t.phase === "trading" ? "until the bell" : "dealing"}</div>
    </div>
  );
}

function SeatBar({ t, now, wantSeat, busy, onSit }: { t: TableState; now: number; wantSeat: boolean; busy: string | null; onSit: () => void }) {
  const free = freeSeats(t);
  if (free.length === 0) return <p className="seatbar">Every seat here is taken by a player. Watch, or pick another table.</p>;
  if (canJoin(t)) {
    return (
      <div className="seatbar">
        <span>{free.length} of 4 seats are held by house bots. Sit in one and the next round deals at once.</span>
        <button className="btn btn-bell" data-testid="take-seat" disabled={wantSeat || !!busy} onClick={onSit}>
          Take a seat
        </button>
      </div>
    );
  }
  return (
    <div className="seatbar">
      {wantSeat ? (
        <span data-testid="queued">Seating you at the bell in {fmtClock(Math.max(0, t.tradeEndTs - now))}.</span>
      ) : (
        <>
          <span>Seats open between rounds.</span>
          <button className="btn btn-ghost" onClick={onSit}>
            Seat me at the bell
          </button>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ my ticket

function Ticket({ seatIndex, mine, t }: { seatIndex: number; mine: SeatState | null; t: TableState }) {
  if (!mine) {
    return (
      <section className="ticket ticket-loading" data-testid="my-ticket">
        <p>Reading your sealed seat with your key…</p>
      </section>
    );
  }
  const need = orderRequirement(mine.order);
  const filled = orderFilled(mine);
  return (
    <section className={`ticket ${JACKETS[seatIndex].cls}`} data-testid="my-ticket" aria-label="Your private hand and order">
      <div className="ticket-top">
        <Jacket seat={seatIndex} label={`${JACKETS[seatIndex].name}, you`} />
        <span className="stamp">Only you can see this</span>
      </div>
      <div className="order">
        <span className="order-label">Your order</span>
        <span className="order-big" data-testid="my-order">
          {mine.order.qtyA} <Suit s={mine.order.suitA} /> + {mine.order.qtyB} <Suit s={mine.order.suitB} />
        </span>
      </div>
      <div className="hand" data-testid="my-hand">
        {mine.hand.map((n, s) => {
          const short = need[s] - n;
          return (
            <div key={s} className={`hold ${need[s] ? (short > 0 ? "hold-short" : "hold-ok") : "hold-spare"}`}>
              <Suit s={s} />
              <span className="hold-n">{n}</span>
              <span className="hold-note">{need[s] ? (short > 0 ? `need ${short}` : "covered") : n ? "spare" : ""}</span>
            </div>
          );
        })}
      </div>
      <div className="ticket-foot">
        <span>
          <b className="mono" data-testid="my-chips">{mine.chips}</b> chips
        </span>
        <span>
          If the bell rang now: <b className="mono">{mine.chips + (filled ? BONUS : 0)}</b>
          {filled ? " (order filled, +100)" : " (order not filled)"}
        </span>
      </div>
      <p className="ticket-help">
        Score = chips + 100 if you hold your whole order at the bell. Sell spares, buy what you need. Round {t.round}.
      </p>
    </section>
  );
}

// ------------------------------------------------------------------ the book

function Board({
  t,
  mySeat,
  mine,
  busy,
  run,
  tablePk,
}: {
  t: TableState;
  mySeat: number;
  mine: SeatState | null;
  busy: boolean;
  run: (label: string, f: () => Promise<act.ActionResult>, okText?: string) => Promise<act.ActionResult>;
  tablePk: PublicKey;
}) {
  const need = mine ? orderRequirement(mine.order) : [0, 0, 0, 0];
  const seated = mySeat >= 0 && !!mine;
  return (
    <section className="book" aria-label="Order book" data-testid="book">
      <h2 className="book-title">Book</h2>
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
            <div className="book-best">
              <button
                className="hit hit-sell"
                data-testid={`sell-${s}`}
                disabled={!seated || !bid || busy}
                title={bid ? `Sell one ${["spade", "club", "heart", "diamond"][s]} to ${JACKETS[bid.seat].name} at ${bid.price}` : "No bid"}
                onClick={() => bid && run("Selling…", () => act.take(tablePk, mySeat, s, SIDE_BID, bid.seat, bid.price), `Sold 1 at ${bid.price}.`)}
              >
                <span className="hit-verb">Sell</span>
                <span className="hit-px mono">{bid ? bid.price : "–"}</span>
                {bid ? <span className={`hit-who ${JACKETS[bid.seat].cls}`} /> : null}
              </button>
              <button
                className="hit hit-buy"
                data-testid={`buy-${s}`}
                disabled={!seated || !ask || busy}
                title={ask ? `Buy one from ${JACKETS[ask.seat].name} at ${ask.price}` : "No offer"}
                onClick={() => ask && run("Buying…", () => act.take(tablePk, mySeat, s, SIDE_ASK, ask.seat, ask.price), `Bought 1 at ${ask.price}.`)}
              >
                <span className="hit-verb">Buy</span>
                <span className="hit-px mono">{ask ? ask.price : "–"}</span>
                {ask ? <span className={`hit-who ${JACKETS[ask.seat].cls}`} /> : null}
              </button>
            </div>
            <div className="ladder" aria-label="Quotes by seat">
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className={`rung ${JACKETS[i].cls} ${i === mySeat ? "rung-me" : ""}`} title={`${JACKETS[i].name}${i === mySeat ? " (you)" : ""}: bid ${t.bids[s][i] || "–"}, offer ${t.asks[s][i] || "–"}`}>
                  <span className="mono">{t.bids[s][i] || "·"}</span>
                  <span className="rung-sep">/</span>
                  <span className="mono">{t.asks[s][i] || "·"}</span>
                </span>
              ))}
            </div>
            {seated ? <QuoteBox t={t} s={s} mySeat={mySeat} mine={mine!} want={want} busy={busy} run={run} tablePk={tablePk} /> : null}
          </div>
        );
      })}
      {!seated && mySeat < 0 ? <p className="book-foot">Watching. Bids / offers per jacket; take a seat to trade.</p> : null}
    </section>
  );
}

function QuoteBox({
  t,
  s,
  mySeat,
  mine,
  want,
  busy,
  run,
  tablePk,
}: {
  t: TableState;
  s: number;
  mySeat: number;
  mine: SeatState;
  want: number;
  busy: boolean;
  run: (label: string, f: () => Promise<act.ActionResult>, okText?: string) => Promise<act.ActionResult>;
  tablePk: PublicKey;
}) {
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
      <input
        id={`px-${s}`}
        className="px mono"
        inputMode="numeric"
        value={px}
        data-testid={`px-${s}`}
        onChange={(e) => setPx(e.target.value.replace(/[^0-9]/g, "").slice(0, 2))}
      />
      <button className="btn btn-small btn-bid" data-testid={`bid-${s}`} disabled={busy || !valid || mine.chips < price} onClick={() => send(SIDE_BID)}>
        Bid
      </button>
      <button className="btn btn-small btn-ask" data-testid={`offer-${s}`} disabled={busy || !valid || mine.hand[s] === 0} onClick={() => send(SIDE_ASK)}>
        Offer
      </button>
      <span className="myquotes">
        {myBid ? (
          <button className="chip chip-bid" title="Cancel my bid" onClick={() => run("Cancelling…", () => act.cancel(tablePk, t, mySeat, s, SIDE_BID), "Bid cancelled.")}>
            bid {myBid} ✕
          </button>
        ) : null}
        {myAsk ? (
          <button className="chip chip-ask" title="Cancel my offer" onClick={() => run("Cancelling…", () => act.cancel(tablePk, t, mySeat, s, SIDE_ASK), "Offer cancelled.")}>
            offer {myAsk} ✕
          </button>
        ) : null}
      </span>
    </div>
  );
}

// ------------------------------------------------------------------ tape

function roundTape(t: TableState): TradePrint[] {
  return t.tape.filter((p) => p.round === t.round);
}

function Tape({ t, mySeat }: { t: TableState; mySeat: number }) {
  const prints = roundTape(t).slice().reverse();
  return (
    <section className="tape" aria-label="Trades this round" data-testid="tape">
      <h2 className="tape-title">Tape</h2>
      {prints.length === 0 ? <p className="empty">No trades yet this round.</p> : null}
      <ol className="prints">
        {prints.map((p, k) => (
          <li key={`${p.slot}-${k}`} className={p.buyer === mySeat || p.seller === mySeat ? "print-mine" : ""}>
            <span className="mono ptime">{new Date(p.unixTs * 1000).toLocaleTimeString([], { minute: "2-digit", second: "2-digit" })}</span>
            <Suit s={p.suit} />
            <span className="mono ppx">{p.price}</span>
            <span className="pflow">
              <span className={`dot ${JACKETS[p.seller].cls}`} title={`${JACKETS[p.seller].name} sold`} />
              <span className="arrow" aria-hidden="true">›</span>
              <span className={`dot ${JACKETS[p.buyer].cls}`} title={`${JACKETS[p.buyer].name} bought`} />
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ------------------------------------------------------------------ reveal

function Reveal({
  t,
  reveal,
  mySeat,
  tablePk,
  probe,
  walletAddr,
  actions,
}: {
  t: TableState;
  reveal: (SeatState | null)[] | null;
  mySeat: number;
  tablePk: PublicKey;
  probe: { seat: number; at: number; hidden: boolean } | null;
  walletAddr: string | null;
  actions: React.ReactNode;
}) {
  const order = [0, 1, 2, 3].sort((a, b) => t.ranks[a] - t.ranks[b]);
  const prints = roundTape(t);
  const me = sessionKey().publicKey.toBase58();
  return (
    <section className="reveal" data-testid="reveal">
      <div className="reveal-head">
        <h2>Bell. Round {t.round} is over.</h2>
        {actions}
      </div>
      <ol className="scores" data-testid="scoreboard">
        {order.map((i) => {
          const chips = t.scores[i] - (t.filled[i] ? BONUS : 0);
          const who = t.seats[i].kind === "human" ? (t.seats[i].owner.toBase58() === me ? "you" : "player") : "house bot";
          return (
            <li key={i} className={`score ${i === mySeat ? "score-me" : ""}`}>
              <span className="rank mono">{t.ranks[i] + 1}</span>
              <Jacket seat={i} />
              <span className="who">{who}</span>
              <span className="pts mono">{t.scores[i]}</span>
              <span className="calc">
                {t.filled[i] ? `${chips} chips + 100 for the filled order` : `${chips} chips, order missed`}
              </span>
            </li>
          );
        })}
      </ol>

      <div className="flipped">
        {[0, 1, 2, 3].map((i) => {
          const s = reveal?.[i] ?? null;
          return (
            <div key={i} className={`card-flip ${s ? "is-open" : ""}`} style={{ animationDelay: `${i * 120}ms` }} data-testid="revealed-seat">
              <div className={`ticket ticket-small ${JACKETS[i].cls}`}>
                <div className="ticket-top">
                  <Jacket seat={i} />
                  <span className={`stamp ${s ? "stamp-open" : ""}`}>{s ? "Revealed" : "Sealed"}</span>
                </div>
                {s ? (
                  <>
                    <div className="order-big small">
                      {s.order.qtyA} <Suit s={s.order.suitA} /> + {s.order.qtyB} <Suit s={s.order.suitB} />
                    </div>
                    <div className="hand mini">
                      {s.hand.map((n, k) => (
                        <span key={k} className={`hold ${orderRequirement(s.order)[k] > n ? "hold-short" : ""}`}>
                          <Suit s={k} /> <span className="hold-n">{n}</span>
                        </span>
                      ))}
                    </div>
                    <div className="ticket-foot">
                      <span>{s.chips} chips</span>
                      <span>{t.filled[i] ? "Order filled" : "Order missed"}</span>
                    </div>
                  </>
                ) : (
                  <p className="sealed">Opening…</p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <TapeReplay prints={prints} />
      <PrivacyStory t={t} tablePk={tablePk} probe={probe} mySeat={mySeat} walletAddr={walletAddr} />
    </section>
  );
}

function TapeReplay({ prints }: { prints: TradePrint[] }) {
  const [step, setStep] = useState(-1);
  useEffect(() => {
    if (step < 0 || step >= prints.length) return;
    const id = setTimeout(() => setStep((x) => (x + 1 >= prints.length ? -1 : x + 1)), 650);
    return () => clearTimeout(id);
  }, [step, prints.length]);
  return (
    <section className="replay" aria-label="Round tape">
      <div className="replay-head">
        <h3>The round's tape, {prints.length} trades</h3>
        {prints.length ? (
          <button className="btn btn-ghost btn-small" onClick={() => setStep(0)}>
            {step >= 0 ? "Replaying…" : "Replay"}
          </button>
        ) : null}
      </div>
      <ol className="replay-strip">
        {prints.map((p, k) => (
          <li key={k} className={k === step ? "on" : k < step ? "past" : ""}>
            <Suit s={p.suit} />
            <span className="mono">{p.price}</span>
            <span className="pflow">
              <span className={`dot ${JACKETS[p.seller].cls}`} />
              <span className="arrow" aria-hidden="true">›</span>
              <span className={`dot ${JACKETS[p.buyer].cls}`} />
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
      <h3>What was private, and when it flipped</h3>
      <ol className="timeline">
        <li>
          <b>Seats sealed.</b> Starting the round made each seat's permission private on the TEE rollup: a seat can be
          read only with its owner's signed-in key. Bot seats have no player reader; when the house dealer starts a
          round, its key sits in one seat just long enough to deal and stays that seat's only reader.{" "}
          {startTx ? <TxLink sig={startTx.sig} layer="er">your start transaction</TxLink> : flips?.seal ? <TxLink sig={flips.seal} layer="er">seal transaction</TxLink> : null}
        </li>
        <li>
          <b>Cards dealt in the dark.</b> A VRF callback shuffled the deck and wrote eight cards, 200 chips and a secret order
          into each sealed seat. While the round ran, the TEE redacted that transaction for every viewer, because its
          randomness decides every hand. Now that every hand is public, it is readable too.{" "}
          {flips?.deal ? <TxLink sig={flips.deal} layer="er">deal transaction</TxLink> : null}
        </li>
        <li>
          <b>Trading.</b> Prices and trades were public on the table account; hands and orders were not.
          {probe ? (
            <>
              {" "}
              At {new Date(probe.at).toLocaleTimeString()} this page tried to read the <Jacket seat={probe.seat} /> seat with your key:{" "}
              <b>{probe.hidden ? "hidden" : "visible (unexpected)"}</b>.
            </>
          ) : null}
          {trades.length ? (
            <>
              {" "}
              Your actions:{" "}
              {trades.slice(0, 6).map((e) => (
                <span key={e.sig}>
                  <TxLink sig={e.sig} layer="er">{e.label}</TxLink>{" "}
                </span>
              ))}
            </>
          ) : null}
        </li>
        <li>
          <b>Bell: everything flips public.</b> Ringing the bell scored the round and set all four permissions public, so
          anyone can now read every hand and order above.{" "}
          {flips?.bell ? <TxLink sig={flips.bell} layer="er">bell transaction (rung by the crank)</TxLink> : <span className="muted">(rung by the on-chain crank)</span>}
        </li>
        <li>
          <b>Results to Solana.</b> <code>publish_records</code> scheduled a Magic Action that updates wallet-bound player
          records on the devnet base layer{t.recordsRound >= t.round ? "" : " (pending)"}.{" "}
          {publish ? <TxLink sig={publish.sig} layer="er">publish transaction</TxLink> : null}{" "}
          {recordAddr ? <AddrLink addr={recordAddr} layer="base">your player record</AddrLink> : <span className="muted">Seats without a bound wallet are skipped.</span>}
        </li>
      </ol>
    </section>
  );
}

function MyTxs({ address, round }: { address: string; round: number }) {
  const log = useTxLog().filter((e) => e.table === address && (e.round ?? 0) >= round - 1);
  if (!log.length) return null;
  return (
    <details className="mytx">
      <summary>Your transactions here ({log.length})</summary>
      <ul>
        {log.map((e) => (
          <li key={e.sig}>
            <span className="muted">r{e.round}</span> {e.label} <TxLink sig={e.sig} layer={e.layer} />
          </li>
        ))}
      </ul>
    </details>
  );
}

import { useMemo, useState } from "react";
import { TableState, canJoin, freeSeats, seatOf } from "@outcry/client";
import { HOUSE_TABLES, HUMAN_GRACE_SECS } from "./config";
import { useErNow, useTables } from "./lib/hooks";
import { sessionKey } from "./lib/outcry";
import { JACKETS, fmtClock, go, phaseText } from "./ui";

/** Pick where "Play now" seats a guest: a joinable table now, else the one whose bell is next. */
export function pickTable(tables: Record<string, TableState | null>, now: number): { address: string; wait: number } | null {
  const me = sessionKey().publicKey.toBase58();
  const live = HOUSE_TABLES.map((h) => ({ h, t: tables[h.address] })).filter((x) => x.t) as { h: (typeof HOUSE_TABLES)[number]; t: TableState }[];
  const mine = live.find((x) => seatOf(x.t, me) >= 0);
  if (mine) return { address: mine.h.address, wait: 0 };
  const open = live.filter((x) => canJoin(x.t) && freeSeats(x.t).length > 0);
  if (open.length) {
    // Prefer the most free seats, then the most recent bell: the table settled longest is the one
    // the house dealer deals next, so joining it is most likely to lose that race.
    open.sort((a, b) => freeSeats(b.t).length - freeSeats(a.t).length || b.t.tradeEndTs - a.t.tradeEndTs);
    return { address: open[0].h.address, wait: 0 };
  }
  const trading = live.filter((x) => x.t.phase === "trading" && freeSeats(x.t).length > 0);
  if (trading.length) {
    trading.sort((a, b) => a.t.tradeEndTs - b.t.tradeEndTs);
    return { address: trading[0].h.address, wait: Math.max(0, trading[0].t.tradeEndTs - now) };
  }
  const any = live.find((x) => freeSeats(x.t).length > 0);
  return any ? { address: any.h.address, wait: 30 } : null;
}

export function Lobby() {
  const addresses = useMemo(() => HOUSE_TABLES.map((h) => h.address), []);
  const tables = useTables(addresses);
  const now = useErNow(1000);
  const [busy, setBusy] = useState(false);
  const loaded = Object.keys(tables).length > 0;
  const me = sessionKey().publicKey.toBase58();
  const pick = loaded ? pickTable(tables, now) : null;

  return (
    <main className="lobby">
      <section className="hero">
        <div className="hero-copy">
          <h1 className="wordmark">Outcry</h1>
          <p className="pitch">
            A 60-second trading pit for four. You get eight cards and a secret order nobody else can see. Buy and sell
            cards against the house bots before the bell. Fill your order and finish with the most chips.
          </p>
          <div className="hero-actions">
            <button
              className="btn btn-bell"
              data-testid="play-now"
              disabled={!pick || busy}
              onClick={() => {
                if (!pick) return;
                setBusy(true);
                go(`/t/${pick.address}?play=1`);
              }}
            >
              {!loaded ? "Finding a table…" : pick ? "Play now" : "All seats taken"}
            </button>
            <span className="hint">
              {pick && pick.wait > 0
                ? `Next free seat opens at the bell in ${fmtClock(pick.wait)}.`
                : "No wallet needed. Your browser holds a throwaway key with 0 SOL."}
            </span>
          </div>
        </div>
        <TicketArt />
      </section>

      <section className="board" aria-label="House tables">
        <div className="board-head">
          <h2>House tables</h2>
          <span className="board-sub">Live on the MagicBlock private rollup. Bots play every round; take a seat between rounds.</span>
        </div>
        <div className="board-rows" role="table">
          <div className="board-row board-row-head" role="row">
            <span role="columnheader">Table</span>
            <span role="columnheader">Round</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Seats</span>
            <span role="columnheader" />
          </div>
          {HOUSE_TABLES.map((h) => {
            const t = tables[h.address];
            const free = t ? freeSeats(t).length : 0;
            const seated = t ? seatOf(t, me) >= 0 : false;
            return (
              <div className="board-row" role="row" key={h.address} data-testid="lobby-table">
                <span className="tname" role="cell">
                  {h.name}
                </span>
                <span className="mono" role="cell">
                  {t ? t.round : "–"}
                </span>
                <span className={`status ph-${t?.phase ?? "none"}`} role="cell">
                  {t ? phaseText(t, now) : loaded ? "Unreachable" : "Loading"}
                  {t && t.phase === "settled" && now - t.tradeEndTs < HUMAN_GRACE_SECS + 5 ? <em className="open-tag">seats open</em> : null}
                </span>
                <span className="seats" role="cell" aria-label={`${free} of 4 seats free`}>
                  {t
                    ? t.seats.map((s, i) => (
                        <span key={i} className={`seatpip ${JACKETS[i].cls} ${s.kind === "human" ? "taken" : ""}`} title={`${JACKETS[i].name}: ${s.kind === "human" ? (s.owner.toBase58() === me ? "you" : "player") : "house bot"}`} />
                      ))
                    : null}
                </span>
                <span role="cell">
                  <a className="btn btn-ghost" href={`#/t/${h.address}`}>
                    {seated ? "Back to my seat" : "Watch"}
                  </a>
                </span>
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}

/** A stack of order tickets, the one decorative object on the page. */
function TicketArt() {
  return (
    <div className="ticket-art" aria-hidden="true">
      <div className="slip slip-back">
        <span>SELL 1 ♥ @ 18</span>
      </div>
      <div className="slip slip-mid">
        <span>BUY 1 ♣ @ 21</span>
      </div>
      <div className="slip slip-front">
        <div className="slip-row">
          <span>Order</span>
          <span className="stamp">Private</span>
        </div>
        <div className="slip-big">4 ♣ + 2 ♦</div>
        <div className="slip-row">
          <span>Hand ♠2 ♣1 ♥2 ♦3</span>
          <span>200 chips</span>
        </div>
      </div>
    </div>
  );
}

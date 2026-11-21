import { CSSProperties, useMemo, useState } from "react";
import { TableState, canJoin, freeSeats, seatOf } from "@outcry/client";
import { HOUSE_TABLES, HUMAN_GRACE_SECS } from "./config";
import { useErNow, useTables } from "./lib/hooks";
import { sessionKey } from "./lib/outcry";
import { Card, Roll, Seat, Suit, Tick, fmtClock, go, phaseText, seatKind } from "./ui";

/** The hero hand: eight cards, as every seat is dealt. */
const HERO_HAND = [0, 0, 0, 2, 2, 1, 3, 3];

/** Last print of each suit in the table's current round (null where that suit has not traded). */
function lastPrices(t: TableState): (number | null)[] {
  const last: (number | null)[] = [null, null, null, null];
  for (const p of t.tape) if (p.round === t.round) last[p.suit] = p.price;
  return last;
}

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
    <main className="lobby container">
      <section className="hero">
        <div className="fan" aria-hidden="true">
          <div className="fan-sway">
            {HERO_HAND.map((suit, i) => (
              <Card key={i} s={suit} style={{ "--i": i } as CSSProperties} />
            ))}
          </div>
        </div>
        <h1>Trade your hand before the bell rings.</h1>
        <p className="lede">Eight cards, a secret order, sixty seconds. Fill your order and finish with the most chips.</p>
        <div className="hero-actions">
          <button
            className="btn btn-fill btn-big"
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
          <p className="hint">
            {pick && pick.wait > 0 ? (
              <>
                The next free seat opens at the bell in <span className="num">{fmtClock(pick.wait)}</span>.
              </>
            ) : (
              "No wallet needed. Your browser holds a throwaway key with 0 SOL."
            )}
          </p>
        </div>
      </section>

      <section className="pits" aria-labelledby="pits-h">
        <div className="pits-head">
          <h2 id="pits-h">House pits</h2>
          <p>House bots trade every round. Seats open between rounds.</p>
        </div>
        <ul className="pit-rows">
          {HOUSE_TABLES.map((h) => {
            const t = tables[h.address];
            const free = t ? freeSeats(t).length : 0;
            const seated = t ? seatOf(t, me) >= 0 : false;
            const open = !!t && t.phase === "settled" && now - t.tradeEndTs < HUMAN_GRACE_SECS + 5;
            const left = t && t.phase === "trading" ? Math.max(0, t.tradeEndTs - now) : null;
            const last = t ? lastPrices(t) : null;
            const traded = !!last && last.some((p) => p !== null);
            return (
              <li key={h.address}>
                <a className={`pit-row ${t ? "" : "is-loading"}`} href={`#/t/${h.address}`} data-testid="lobby-table">
                  <span className="pit-name">{h.name}</span>
                  <span className="pit-round num">
                    {t ? (
                      <>
                        round <Tick v={t.round} />
                      </>
                    ) : null}
                  </span>
                  <span className={`status ph-${t?.phase ?? "none"}`}>
                    {t
                      ? left !== null
                        ? "Trading"
                        : open
                          ? "Seats open now"
                          : t.phase === "settled" && now - t.tradeEndTs > 600
                            ? "Between rounds"
                            : phaseText(t, now)
                      : loaded
                        ? "Unreachable"
                        : "Loading"}
                  </span>
                  <span className="pit-last" role="group" aria-label={traded ? "Last price of each suit this round" : undefined}>
                    {traded
                      ? last!.map((p, suit) => (
                          <span key={suit} className={`s${suit} ${p === null ? "is-none" : ""}`}>
                            <Suit s={suit} />
                            <span className="num">{p === null ? "–" : <Tick v={p} />}</span>
                          </span>
                        ))
                      : null}
                  </span>
                  <span className="pit-seats" role="group" aria-label={t ? `${free} of 4 seats free` : undefined}>
                    {t ? t.seats.map((_, i) => <Seat key={i} seat={i} kind={seatKind(t, i, me)} />) : null}
                  </span>
                  <span className={`pit-clock num ${left !== null && left < 10 ? "is-late" : ""}`}>
                    {left !== null ? (
                      <>
                        <span className="sr-only">Bell in </span>
                        <Roll text={fmtClock(left)} />
                      </>
                    ) : null}
                  </span>
                  <span className="pit-go">{seated ? "Back to my seat" : "Watch"}</span>
                  {left !== null && t ? (
                    <span
                      className={`pit-drain ${left < 10 ? "is-late" : ""}`}
                      style={{ transform: `scaleX(${Math.min(1, left / t.windowSecs)})` }}
                      aria-hidden="true"
                    />
                  ) : null}
                </a>
              </li>
            );
          })}
        </ul>
      </section>
    </main>
  );
}

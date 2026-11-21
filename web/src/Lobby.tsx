import { useMemo, useState } from "react";
import { TableState, canJoin, freeSeats, seatOf } from "@outcry/client";
import { HOUSE_TABLES, HUMAN_GRACE_SECS } from "./config";
import { useErNow, useTables } from "./lib/hooks";
import { sessionKey } from "./lib/outcry";
import pit1600 from "./assets/img/pit-gallery-1600.webp";
import pit900 from "./assets/img/pit-gallery-900.webp";
import { JACKETS, JacketPortrait, Tick, fmtClock, go, phaseText } from "./ui";

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
        <img
          className="hero-img"
          src={pit1600}
          srcSet={`${pit900} 900w, ${pit1600} 1600w`}
          sizes="100vw"
          width={1600}
          height={900}
          alt="Looking down from the gallery into a stepped octagonal trading pit, traders in red, green, gold and blue jackets with their hands up."
          decoding="async"
        />
        <div className="hero-copy container">
          <h1 className="hero-head">Trade your hand before the bell rings.</h1>
          <div className="hero-card">
            <p className="pitch">
              Four seats, sixty seconds. You get eight cards and a secret order nobody else can see. Buy and sell against the
              house bots, fill your order and finish with the most chips.
            </p>
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
              <span className="hint">
                {pick && pick.wait > 0 ? (
                  <>
                    The next free seat opens at the bell in <span className="num">{fmtClock(pick.wait)}</span>.
                  </>
                ) : (
                  "No wallet needed. Your browser holds a throwaway key with 0 SOL."
                )}
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="jackets container" aria-labelledby="jackets-h">
        <div className="jackets-copy">
          <h2 id="jackets-h">Four jackets on the hook</h2>
          <p>House bots wear all four between players. Take a seat and you wear one for the round, numbered on its badge.</p>
        </div>
        <ul className="jacket-row">
          {JACKETS.map((j, i) => (
            <li key={j.cls}>
              <JacketPortrait seat={i} />
              <span className="jacket-cap">
                <b>{j.name}</b> seat {i + 1}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="tables container" aria-labelledby="tables-h">
        <div className="tables-head">
          <h2 id="tables-h">House tables</h2>
          <p>Live on the MagicBlock private rollup. Bots trade every round. Seats open between rounds.</p>
        </div>
        <div className="table-rows" role="table" aria-label="House tables">
          <div className="table-row table-row-head" role="row">
            <span role="columnheader">Table</span>
            <span role="columnheader">Round</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Seats</span>
            <span role="columnheader">
              <span className="sr-only">Action</span>
            </span>
          </div>
          {HOUSE_TABLES.map((h) => {
            const t = tables[h.address];
            const free = t ? freeSeats(t).length : 0;
            const seated = t ? seatOf(t, me) >= 0 : false;
            const open = !!t && t.phase === "settled" && now - t.tradeEndTs < HUMAN_GRACE_SECS + 5;
            return (
              <div className={`table-row ${t ? "" : "is-loading"}`} role="row" key={h.address} data-testid="lobby-table">
                <span className="tname" role="cell">
                  {h.name}
                </span>
                <span className="tround num" role="cell">
                  {t ? <Tick v={t.round} /> : "–"}
                </span>
                <span className={`status ph-${t?.phase ?? "none"}`} role="cell">
                  {t ? phaseText(t, now) : loaded ? "Unreachable" : "Loading"}
                  {open ? <span className="open-tag">Seats open now</span> : null}
                </span>
                <span className="seats" role="cell" aria-label={t ? `${free} of 4 seats free` : undefined}>
                  {t
                    ? t.seats.map((s, i) => {
                        const who = s.kind === "human" ? (s.owner.toBase58() === me ? "you" : "player") : "bot";
                        return (
                          <span key={i} className={`seat-tag ${JACKETS[i].cls} ${s.kind === "human" ? "is-taken" : ""}`} title={`${JACKETS[i].name}: ${who === "bot" ? "house bot" : who}`}>
                            <b>{i + 1}</b>
                            <span>{who}</span>
                          </span>
                        );
                      })
                    : null}
                </span>
                <span className="tgo" role="cell">
                  <a className="btn btn-line" href={`#/t/${h.address}`}>
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

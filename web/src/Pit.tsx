import { CSSProperties, ReactNode } from "react";
import { SeatState, TableState, TradePrint, orderRequirement } from "@outcry/client";
import { JACKETS, SUIT_GLYPH, SUIT_NAME, Suit, Tick, fmtClock, ordinal, useMedia } from "./ui";

/** Prints of the current round, oldest first. */
export function roundTape(t: TableState): TradePrint[] {
  return t.tape.filter((p) => p.round === t.round);
}

/** Where each seat stands: you (when seated) at the front, then clockwise. */
export function pitPosition(seat: number, mySeat: number): number {
  return (seat - (mySeat >= 0 ? mySeat : 0) + 4) % 4;
}

/** Pit-floor shorthand for one seat's quote in one suit: "14 at 22", "9 bid", "at 30". */
export function pencilQuote(bid: number, ask: number): string | null {
  if (bid && ask) return `${bid} at ${ask}`;
  if (bid) return `${bid} bid`;
  if (ask) return `at ${ask}`;
  return null;
}

/** What a revealed seat still lacked at the bell: "1 ♥, 2 ♣", or "" when filled. */
export function shortfall(s: SeatState): string {
  const need = orderRequirement(s.order);
  return need
    .map((n, k) => ({ k, gap: n - s.hand[k] }))
    .filter((x) => x.gap > 0)
    .map((x) => `${x.gap} ${SUIT_GLYPH[x.k]}`)
    .join(", ");
}

// ------------------------------------------------------------------ layout, in drawing units
// Every element in the pit is placed in the SVG's own units, so the clock, badges, quote tabs,
// trade slips and reveal cards can be checked against each other before anything is drawn.

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Mode = "wide" | "phone" | "phone-reveal";

interface SeatSpot {
  badge: Box;
  /** The quote tab hangs to the right of the badge (front and back seats) or below it (sides). */
  tabDir: "right" | "below";
  /** The reveal card: left, width and either top or bottom (its height follows the content). */
  card: { x: number; w: number; top?: number; bottom?: number };
}

interface Layout {
  mode: Mode;
  W: number;
  H: number;
  cx: number;
  cy: number;
  clockR: number;
  lineH: number;
  cellW: number;
  tabPad: number;
  slipFont: number;
  maxArcs: number;
  maxSlips: number;
  /** Spots by pit position: front, left, back, right. */
  spots: SeatSpot[];
}

function layout(mode: Mode, settled: boolean): Layout {
  if (mode === "wide") {
    const W = 960;
    const H = 540;
    const bh = 58;
    const bw = settled ? 214 : 160;
    const fx = settled ? 250 : 400;
    return {
      mode,
      W,
      H,
      cx: W / 2,
      cy: H / 2,
      clockR: settled ? 92 : 123,
      lineH: 22,
      cellW: 104,
      tabPad: 7,
      slipFont: 20,
      maxArcs: 8,
      maxSlips: 4,
      spots: [
        { badge: { x: fx, y: H - 8 - bh, w: bw, h: bh }, tabDir: "right", card: { x: fx + bw, w: 252, bottom: 8 } },
        { badge: { x: 12, y: settled ? 140 : 187, w: bw, h: bh }, tabDir: "below", card: { x: 12, w: 252, top: 198 } },
        { badge: { x: fx, y: 8, w: bw, h: bh }, tabDir: "right", card: { x: fx + bw, w: 252, top: 8 } },
        { badge: { x: W - 12 - bw, y: settled ? 140 : 187, w: bw, h: bh }, tabDir: "below", card: { x: W - 12 - 252, w: 252, top: 198 } },
      ],
    };
  }
  if (mode === "phone-reveal") {
    const W = 600;
    const H = 900;
    const bh = 56;
    const bw = 224;
    return {
      mode,
      W,
      H,
      cx: W / 2,
      cy: 452,
      clockR: 88,
      lineH: 22,
      cellW: 124,
      tabPad: 6,
      slipFont: 24,
      maxArcs: 0,
      maxSlips: 0,
      spots: [
        { badge: { x: 188, y: H - 8 - bh, w: bw, h: bh }, tabDir: "right", card: { x: 160, w: 280, bottom: 8 + bh + 6 } },
        { badge: { x: 8, y: 292, w: bw, h: bh }, tabDir: "below", card: { x: 8, w: 192, top: 354 } },
        { badge: { x: 188, y: 8, w: bw, h: bh }, tabDir: "right", card: { x: 160, w: 280, top: 70 } },
        { badge: { x: W - 8 - bw, y: 292, w: bw, h: bh }, tabDir: "below", card: { x: W - 8 - 192, w: 192, top: 354 } },
      ],
    };
  }
  const W = 600;
  const H = 560;
  const bh = 56;
  const bw = 146;
  return {
    mode,
    W,
    H,
    cx: W / 2,
    cy: 284,
    clockR: 132,
    lineH: 22,
    cellW: 124,
    tabPad: 6,
    slipFont: 24,
    maxArcs: 3,
    maxSlips: 1,
    spots: [
      { badge: { x: 110, y: H - 8 - bh, w: bw, h: bh }, tabDir: "right", card: { x: 110, w: 280, bottom: 70 } },
      { badge: { x: 8, y: 207, w: bw, h: bh }, tabDir: "below", card: { x: 8, w: 180, top: 270 } },
      { badge: { x: 110, y: 8, w: bw, h: bh }, tabDir: "right", card: { x: 110, w: 280, top: 70 } },
      { badge: { x: W - 8 - bw, y: 207, w: bw, h: bh }, tabDir: "below", card: { x: W - 8 - 180, w: 180, top: 270 } },
    ],
  };
}

/** The quote tab's box for a seat with `lines` quoted suits (0 = the "no quotes" note). */
function tabBox(L: Layout, spot: SeatSpot, lines: number): Box {
  const { badge } = spot;
  const n = Math.max(1, lines);
  if (spot.tabDir === "right") {
    const cols = Math.ceil(n / 2);
    return { x: badge.x + badge.w, y: badge.y, w: cols * L.cellW + 2 * L.tabPad, h: badge.h };
  }
  const w = Math.min(badge.w, L.cellW + 2 * L.tabPad);
  const rightAligned = badge.x > L.cx;
  return { x: rightAligned ? badge.x + badge.w - w : badge.x, y: badge.y + badge.h, w, h: n * L.lineH + 2 * L.tabPad };
}

function centre(b: Box): [number, number] {
  return [b.x + b.w / 2, b.y + b.h / 2];
}

function overlaps(a: Box, b: Box, pad = 4): boolean {
  return a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
}

function hitsCircle(b: Box, cx: number, cy: number, r: number): boolean {
  const nx = Math.max(b.x, Math.min(cx, b.x + b.w));
  const ny = Math.max(b.y, Math.min(cy, b.y + b.h));
  return Math.hypot(nx - cx, ny - cy) < r;
}

function pct(v: number, of: number): string {
  return `${((v / of) * 100).toFixed(3)}%`;
}

function boxStyle(L: Layout, b: Box): CSSProperties {
  return { left: pct(b.x, L.W), top: pct(b.y, L.H), width: pct(b.w, L.W), height: pct(b.h, L.H) };
}

function octagon(cx: number, cy: number, a: number, b: number, c: number): string {
  const p = [
    [cx - a + c, cy - b],
    [cx + a - c, cy - b],
    [cx + a, cy - b + c],
    [cx + a, cy + b - c],
    [cx + a - c, cy + b],
    [cx - a + c, cy + b],
    [cx - a, cy + b - c],
    [cx - a, cy - b + c],
  ];
  return p.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
}

// ------------------------------------------------------------------ the pit

export interface PitProps {
  /** null while the table is still loading: the empty pit is the skeleton. */
  t: TableState | null;
  now: number;
  mySeat: number;
  me: string;
  reveal?: (SeatState | null)[] | null;
  /** Your trading card, or the seat offer: laid at the pit's front edge. */
  front?: ReactNode;
}

interface Arc {
  key: string;
  age: number;
  d: string;
  end: [number, number];
  slip: { x: number; y: number; tilt: string; text: string } | null;
}

export function Pit({ t, now, mySeat, me, reveal = null, front }: PitProps) {
  const portrait = useMedia("(max-width: 40rem)");
  const phase = t?.phase ?? "loading";
  const settled = phase === "settled";
  const L = layout(portrait ? (settled ? "phone-reveal" : "phone") : "wide", settled);
  const { W, H, cx, cy } = L;

  const posOf = (i: number) => (t ? pitPosition(i, mySeat) : i);
  const quoteLines = (i: number) => (t ? [0, 1, 2, 3].filter((s) => t.bids[s][i] || t.asks[s][i]).length : 0);
  const showTabs = !!t && phase === "trading";
  const tabs: (Box | null)[] = [0, 1, 2, 3].map((i) => (showTabs ? tabBox(L, L.spots[posOf(i)], quoteLines(i)) : null));
  const obstacles: Box[] = [0, 1, 2, 3].flatMap((i) => [L.spots[posOf(i)].badge, ...(tabs[i] ? [tabs[i]!] : [])]);

  const left = t && phase === "trading" ? t.tradeEndTs - now : 0;
  const frac = t && phase === "trading" ? Math.max(0, Math.min(1, left / t.windowSecs)) : phase === "dealing" ? 1 : 0;
  const late = phase === "trading" && left < 10;

  const arcs = t && phase === "trading" ? planArcs(L, roundTape(t), mySeat, obstacles) : [];

  // steps: outer (highest) to floor (lowest)
  const d = L.mode === "wide" ? 50 : 46;
  const a0 = W / 2 - 6;
  const b0 = H / 2 - 6;
  const c0 = L.mode === "wide" ? 160 : 150;
  const rings = [0, 1, 2, 3].map((k) => ({ a: a0 - k * d, b: b0 - k * d, c: Math.max(24, c0 - k * d * 0.45) }));
  const pcx = W / 2;
  const pcy = H / 2;

  return (
    <div className={`pit pit-${phase} pit-${L.mode}`}>
      <section className="pit-stage" aria-label="The pit" style={{ aspectRatio: `${W} / ${H}`, "--W": W } as CSSProperties}>
        <svg className="pit-svg" viewBox={`0 0 ${W} ${H}`} aria-hidden="true" focusable="false">
          <defs>
            <mask id="arc-mask" maskUnits="userSpaceOnUse" x="0" y="0" width={W} height={H}>
              <rect width={W} height={H} fill="#fff" />
              <circle cx={cx} cy={cy} r={L.clockR + 10} fill="#000" />
            </mask>
          </defs>
          <polygon className="step-rail" points={octagon(pcx, pcy, rings[0].a + 5, rings[0].b + 5, rings[0].c + 2)} />
          {rings.map((r, k) => (
            <g key={k}>
              {k > 0 ? <polygon className="step-riser" points={octagon(pcx, pcy, r.a + 10, r.b + 10, r.c + 4)} /> : null}
              <polygon className={`step step-${k}`} points={octagon(pcx, pcy, r.a, r.b, r.c)} />
            </g>
          ))}

          {/* the bell clock's ring: drains with the time left; after the bell it is the bell plate */}
          {settled ? (
            <g className="bell-plate">
              <circle cx={cx} cy={cy} r={L.clockR} />
            </g>
          ) : (
            <g className={`clock-ring ${late ? "is-late" : ""}`}>
              <circle className="clock-face" cx={cx} cy={cy} r={L.clockR - 7} />
              <circle className="clock-track" cx={cx} cy={cy} r={L.clockR} />
              <circle
                className="clock-left"
                cx={cx}
                cy={cy}
                r={L.clockR}
                pathLength={1}
                strokeDasharray="1 1"
                style={{ strokeDashoffset: 1 - frac }}
                transform={`rotate(-90 ${cx} ${cy})`}
              />
            </g>
          )}

          {/* trade prints of this round: seller badge to buyer badge, cut at the clock ring */}
          <g className="arcs" mask="url(#arc-mask)">
            {arcs.map((a) => (
              <g key={a.key} className={`arc ${a.age === 0 ? "arc-new" : "arc-old"}`} style={{ "--age": a.age } as CSSProperties}>
                <path className="arc-line" d={a.d} pathLength={1} />
                <circle className="arc-end" cx={a.end[0]} cy={a.end[1]} r={6} />
              </g>
            ))}
          </g>
          <g className="slips">
            {arcs.map((a) =>
              a.slip ? (
                <g key={a.key} className={`arc-slip ${a.age === 0 ? "arc-new" : "arc-old"}`} transform={`translate(${a.slip.x.toFixed(1)} ${a.slip.y.toFixed(1)}) rotate(${a.slip.tilt})`}>
                  <rect x={-slipW(L) / 2} y={-slipH(L) / 2} width={slipW(L)} height={slipH(L)} />
                  <text y={L.slipFont * 0.36} fontSize={L.slipFont}>
                    {a.slip.text}
                  </text>
                </g>
              ) : null,
            )}
          </g>
        </svg>

        {settled ? (
          <div className="clock bell-centre" aria-label={`Bell. Round ${t!.round} is over.`}>
            <span className="bell-round">Round {t!.round}</span>
            <span className="bell-word">Bell</span>
          </div>
        ) : (
          <div className={`clock ${late ? "is-late" : ""}`} data-testid={phase === "trading" || phase === "dealing" ? "bell-clock" : undefined}>
            <span className="clock-num">{phase === "trading" ? <Tick v={fmtClock(left)} /> : "–:––"}</span>
            <span className="clock-label">
              {phase === "trading" ? "until the bell" : phase === "dealing" ? "dealing" : phase === "lobby" ? "no deal yet" : "reading"}
            </span>
          </div>
        )}

        {[0, 1, 2, 3].map((i) => (
          <SeatOnStep key={i} L={L} t={t} i={i} pos={posOf(i)} tab={tabs[i]} mySeat={mySeat} me={me} reveal={reveal} />
        ))}
      </section>
      {front ? <div className="pit-front">{front}</div> : null}
    </div>
  );
}

function slipW(L: Layout): number {
  return L.slipFont * 3.7;
}
function slipH(L: Layout): number {
  return L.slipFont * 1.7;
}

/** Arcs for the newest prints, with each slip placed where it covers no badge, tab, clock or other slip. */
function planArcs(L: Layout, prints: TradePrint[], mySeat: number, obstacles: Box[]): Arc[] {
  const { cx, cy } = L;
  const shown = prints.slice(-L.maxArcs);
  const first = prints.length - shown.length;
  const pairCount = new Map<string, number>();
  const placed: Box[] = [];
  const sw = slipW(L);
  const sh = slipH(L);
  const out: Arc[] = shown.map((p, k) => {
    const age = shown.length - 1 - k;
    const ps = pitPosition(p.seller, mySeat);
    const pb = pitPosition(p.buyer, mySeat);
    const [x0, y0] = centre(L.spots[ps].badge);
    const [x1, y1] = centre(L.spots[pb].badge);
    const pk = `${Math.min(ps, pb)}-${Math.max(ps, pb)}`;
    const n = pairCount.get(pk) ?? 0;
    pairCount.set(pk, n + 1);
    const mx = (x0 + x1) / 2;
    const my = (y0 + y1) / 2;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    // unit normal pointing away from the clock
    let nx = -dy / len;
    let ny = dx / len;
    if ((mx - cx) * nx + (my - cy) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    let bow: number;
    if ((ps - pb + 4) % 4 === 2) {
      // opposite seats: bow round the clock; the side alternates so repeats do not stack
      const side = (p.seller < p.buyer ? 1 : -1) * (n % 2 ? -1 : 1);
      bow = (2 * (L.clockR + sh) + Math.floor(n / 2) * 60) * side;
    } else {
      // neighbours: a gentle bow toward the corner of the pit, repeats fan further out
      bow = 50 + n * 46;
    }
    const qx = mx + nx * bow;
    const qy = my + ny * bow;
    const at = (tt: number): [number, number] => {
      const u = 1 - tt;
      return [u * u * x0 + 2 * u * tt * qx + tt * tt * x1, u * u * y0 + 2 * u * tt * qy + tt * tt * y1];
    };
    return {
      key: `${p.slot}-${first + k}`,
      age,
      d: `M${x0.toFixed(1)},${y0.toFixed(1)} Q${qx.toFixed(1)},${qy.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`,
      end: [x1, y1],
      slip: null,
      _at: at,
      _text: `${SUIT_GLYPH[p.suit]} ${p.price}`,
      _tilt: ((Number(p.slot % 7n) - 3) * 1.2).toFixed(1),
    } as Arc & { _at: (t: number) => [number, number]; _text: string; _tilt: string };
  });
  // newest first gets the best spot
  for (const a of [...out].reverse() as (Arc & { _at: (t: number) => [number, number]; _text: string; _tilt: string })[]) {
    if (a.age >= L.maxSlips) continue;
    for (const tt of [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82]) {
      const [x, y] = a._at(tt);
      const b = { x: x - sw / 2, y: y - sh / 2, w: sw, h: sh };
      if (b.x < 4 || b.y < 4 || b.x + b.w > L.W - 4 || b.y + b.h > L.H - 4) continue;
      if (hitsCircle(b, cx, cy, L.clockR + 9)) continue;
      if (obstacles.some((o) => overlaps(b, o)) || placed.some((o) => overlaps(b, o))) continue;
      placed.push(b);
      a.slip = { x, y, tilt: a._tilt, text: a._text };
      break;
    }
  }
  return out;
}

function SeatOnStep({
  L,
  t,
  i,
  pos,
  tab,
  mySeat,
  me,
  reveal,
}: {
  L: Layout;
  t: TableState | null;
  i: number;
  pos: number;
  tab: Box | null;
  mySeat: number;
  me: string;
  reveal: (SeatState | null)[] | null;
}) {
  const j = JACKETS[i];
  const info = t?.seats[i];
  const kind = !info ? "" : info.kind === "human" ? (info.owner.toBase58() === me ? "you" : "player") : "house bot";
  const phase = t?.phase;
  const spot = L.spots[pos];
  const [bx, by] = centre(spot.badge);
  return (
    <div className={`seat pos-${pos} tab-${spot.tabDir} ${j.cls} ${i === mySeat ? "is-me" : ""} ${t ? "" : "is-empty"}`}>
      <div className="badge" style={boxStyle(L, spot.badge)}>
        <span className="badge-n">{i + 1}</span>
        <span className="badge-txt">
          <b>{j.name}</b>
          <span>{kind || " "}</span>
        </span>
        {t && phase === "settled" ? <span className="badge-rank">{ordinal(t.ranks[i] + 1)}</span> : null}
      </div>

      {t && tab ? <PencilQuotes t={t} i={i} style={boxStyle(L, tab)} /> : null}

      {t && phase === "dealing" ? (
        <span
          className="deal-card"
          aria-hidden="true"
          style={
            {
              left: pct(bx + (L.cx - bx) * 0.38, L.W),
              top: pct(by + (L.cy - by) * 0.38, L.H),
              "--fx": ((L.cx - bx) * 0.62).toFixed(0),
              "--fy": ((L.cy - by) * 0.62).toFixed(0),
              "--d": `${pos * 110}ms`,
            } as CSSProperties
          }
        />
      ) : null}

      {t && phase === "settled" ? <FlipCard L={L} t={t} i={i} pos={pos} s={reveal?.[i] ?? null} /> : null}
    </div>
  );
}

function PencilQuotes({ t, i, style }: { t: TableState; i: number; style: CSSProperties }) {
  const lines = [0, 1, 2, 3]
    .map((s) => ({ s, q: pencilQuote(t.bids[s][i], t.asks[s][i]) }))
    .filter((x) => x.q);
  return (
    <ul className="pencil" aria-label={`${JACKETS[i].name} quotes`} style={style}>
      {lines.length === 0 ? <li className="pencil-none">no quotes</li> : null}
      {lines.map(({ s, q }) => (
        <li key={s} title={`${SUIT_NAME[s]}: bid ${t.bids[s][i] || "none"}, offer ${t.asks[s][i] || "none"}`}>
          <span aria-hidden="true">{SUIT_GLYPH[s]}</span> <Tick v={q} />
          <span className="sr-only"> {SUIT_NAME[s]}</span>
        </li>
      ))}
    </ul>
  );
}

function FlipCard({ L, t, i, pos, s }: { L: Layout; t: TableState; i: number; pos: number; s: SeatState | null }) {
  const c = L.spots[pos].card;
  const style = {
    left: pct(c.x, L.W),
    width: pct(c.w, L.W),
    ...(c.top !== undefined ? { top: pct(c.top, L.H) } : { bottom: pct(c.bottom ?? 0, L.H) }),
    "--d": `${pos * 140}ms`,
  } as unknown as CSSProperties;
  const miss = s ? shortfall(s) : "";
  const filled = s ? t.filled[i] : false;
  return (
    <div className={`card-flip ${s ? "is-open" : ""}`} style={style} data-testid="revealed-seat">
      <div className="card-inner">
        <div className="card-face card-back" aria-hidden={s ? "true" : undefined}>
          <span>{s ? "" : "Opening…"}</span>
        </div>
        <div className="card-face card-front" aria-hidden={s ? undefined : "true"}>
          {s ? (
            <>
              <span className="card-order" aria-label="Order">
                {s.order.qtyA} <Suit s={s.order.suitA} /> + {s.order.qtyB} <Suit s={s.order.suitB} />
              </span>
              <span className="card-hand" aria-label="Hand at the bell">
                {s.hand.map((n, k) => (
                  <span key={k} className={orderRequirement(s.order)[k] ? "is-needed" : ""}>
                    <Suit s={k} />
                    <b>{n}</b>
                  </span>
                ))}
              </span>
              <span className={`card-stamp ${filled ? "is-filled" : "is-missed"}`}>{filled ? "filled" : miss ? `missed: needs ${miss}` : "missed"}</span>
              <span className="card-foot">{s.chips} chips at the bell</span>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

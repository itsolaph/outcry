import { CSSProperties, ReactNode } from "react";
import { SeatState, TableState, TradePrint, orderRequirement } from "@outcry/client";
import floorImg from "./assets/img/floor.webp";
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

interface Geom {
  W: number;
  H: number;
  rings: { a: number; b: number; c: number }[];
  /** Arc anchor per pit position (front, left, back, right), in drawing units. */
  anchors: [number, number][];
  /** Where a dealt card starts, relative to its seat, in container units. */
  dealFrom: [string, string][];
  clockR: number;
  slipFont: number;
}

function geometry(portrait: boolean): Geom {
  const W = portrait ? 600 : 960;
  const H = portrait ? 760 : 540;
  const a0 = W / 2 - 6;
  const b0 = H / 2 - 6;
  const c0 = portrait ? 150 : 160;
  const d = portrait ? 54 : 52;
  const rings = [0, 1, 2, 3].map((k) => ({ a: a0 - k * d, b: b0 - k * d, c: Math.max(24, c0 - k * d * 0.45) }));
  const r = H / W;
  return {
    W,
    H,
    rings,
    anchors: portrait
      ? [
          [W / 2, H * 0.86],
          [W * 0.16, H * 0.44],
          [W / 2, H * 0.12],
          [W * 0.84, H * 0.44],
        ]
      : [
          [W / 2, H * 0.87],
          [W * 0.12, H * 0.42],
          [W / 2, H * 0.12],
          [W * 0.88, H * 0.42],
        ],
    dealFrom: [
      ["0cqi", `${-36 * r}cqi`],
      [portrait ? "30cqi" : "36cqi", `${8 * r}cqi`],
      ["0cqi", `${36 * r}cqi`],
      [portrait ? "-30cqi" : "-36cqi", `${8 * r}cqi`],
    ],
    clockR: portrait ? 104 : 88,
    slipFont: portrait ? 25 : 18,
  };
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

export function Pit({ t, now, mySeat, me, reveal = null, front }: PitProps) {
  const portrait = useMedia("(max-width: 40rem)");
  const g = geometry(portrait);
  const cx = g.W / 2;
  const cy = g.H / 2;
  const phase = t?.phase ?? "loading";
  const prints = t && phase === "trading" ? roundTape(t) : [];
  const shown = prints.slice(-8);
  const firstShown = prints.length - shown.length;

  // Arcs between the same two seats fan out so repeated prints stay readable.
  const pairCount = new Map<string, number>();

  const left = t && phase === "trading" ? t.tradeEndTs - now : 0;
  const frac = t && phase === "trading" ? Math.max(0, Math.min(1, left / t.windowSecs)) : phase === "dealing" ? 1 : 0;
  const late = phase === "trading" && left < 10;

  return (
    <div className={`pit pit-${phase} ${portrait ? "pit-portrait" : "pit-wide"}`}>
      <section className="pit-stage" aria-label="The pit" style={{ aspectRatio: `${g.W} / ${g.H}` }}>
        <svg className="pit-svg" viewBox={`0 0 ${g.W} ${g.H}`} aria-hidden="true" focusable="false">
          <defs>
            <clipPath id="pit-floor">
              <polygon points={octagon(cx, cy, g.rings[3].a, g.rings[3].b, g.rings[3].c)} />
            </clipPath>
          </defs>
          {/* steps, outer (highest) to floor (lowest); each lower step casts a darker riser band */}
          <polygon className="step-rail" points={octagon(cx, cy, g.rings[0].a + 5, g.rings[0].b + 5, g.rings[0].c + 2)} />
          {g.rings.map((r, k) => (
            <g key={k}>
              {k > 0 ? <polygon className="step-riser" points={octagon(cx, cy, r.a + 13, r.b + 13, r.c + 5)} /> : null}
              <polygon className={`step step-${k}`} points={octagon(cx, cy, r.a, r.b, r.c)} />
            </g>
          ))}
          <image
            href={floorImg}
            x={cx - g.rings[3].a}
            y={cy - g.rings[3].b}
            width={g.rings[3].a * 2}
            height={g.rings[3].b * 2}
            preserveAspectRatio="xMidYMid slice"
            clipPath="url(#pit-floor)"
            className="floor-img"
          />

          {/* the bell clock's ring: drains with the time left */}
          {phase !== "settled" ? (
            <g className={`clock-ring ${late ? "is-late" : ""}`}>
              <circle className="clock-face" cx={cx} cy={cy} r={g.clockR - 10} />
              <circle className="clock-track" cx={cx} cy={cy} r={g.clockR} />
              <circle
                className="clock-left"
                cx={cx}
                cy={cy}
                r={g.clockR}
                pathLength={1}
                strokeDasharray="1 1"
                style={{ strokeDashoffset: 1 - frac }}
                transform={`rotate(-90 ${cx} ${cy})`}
              />
            </g>
          ) : null}

          {/* trade prints of this round: seller badge to buyer badge */}
          <g className="arcs">
            {t
              ? shown.map((p, k) => {
                  const idx = firstShown + k;
                  const age = shown.length - 1 - k;
                  const ps = pitPosition(p.seller, mySeat);
                  const pb = pitPosition(p.buyer, mySeat);
                  const [x0, y0] = g.anchors[ps];
                  const [x1, y1] = g.anchors[pb];
                  const pk = `${Math.min(p.seller, p.buyer)}-${Math.max(p.seller, p.buyer)}`;
                  const n = pairCount.get(pk) ?? 0;
                  pairCount.set(pk, n + 1);
                  const mx = (x0 + x1) / 2;
                  const my = (y0 + y1) / 2;
                  const dx = x1 - x0;
                  const dy = y1 - y0;
                  const len = Math.hypot(dx, dy) || 1;
                  let qx: number;
                  let qy: number;
                  if ((ps - pb + 4) % 4 === 2) {
                    // opposite seats: bow sideways so the slip clears the clock; direction decides the side
                    const side = p.seller < p.buyer ? 1 : -1;
                    const bow = (2 * (g.clockR + 36) + n * 64) * side;
                    qx = mx + (-dy / len) * bow;
                    qy = my + (dx / len) * bow;
                  } else {
                    // neighbours: bow in toward the clock; repeats fan out to alternate sides
                    const k2 = 0.4 + (n % 2 ? -1 : 1) * Math.ceil(n / 2) * 0.2;
                    qx = mx + (cx - mx) * k2;
                    qy = my + (cy - my) * k2;
                  }
                  // slips of repeated pairs sit at different points along the curve
                  const tt = 0.5 + ([0, -0.17, 0.17][n % 3] ?? 0);
                  const u = 1 - tt;
                  const lx = u * u * x0 + 2 * u * tt * qx + tt * tt * x1;
                  const ly = u * u * y0 + 2 * u * tt * qy + tt * tt * y1;
                  const tilt = ((Number(p.slot % 7n) - 3) * 1.4).toFixed(1);
                  const sw = g.slipFont * 3.5;
                  const sh = g.slipFont * 1.7;
                  return (
                    <g key={`${p.slot}-${idx}`} className={`arc ${age === 0 ? "arc-new" : "arc-old"}`} style={{ "--age": age } as CSSProperties}>
                      <path className="arc-line" d={`M${x0},${y0} Q${qx.toFixed(1)},${qy.toFixed(1)} ${x1},${y1}`} pathLength={1} />
                      <circle className="arc-end" cx={x1} cy={y1} r={6} />
                      {age < 4 ? (
                      <g className="arc-slip" transform={`translate(${lx.toFixed(1)} ${ly.toFixed(1)}) rotate(${tilt})`}>
                        <rect x={-sw / 2} y={-sh / 2} width={sw} height={sh} rx={3} />
                        <text y={g.slipFont * 0.36} fontSize={g.slipFont}>
                          {SUIT_GLYPH[p.suit]} {p.price}
                        </text>
                      </g>
                      ) : null}
                    </g>
                  );
                })
              : null}
          </g>
        </svg>

        {phase !== "settled" ? (
          <div className={`clock ${late ? "is-late" : ""}`} data-testid={phase === "trading" || phase === "dealing" ? "bell-clock" : undefined}>
            <span className="clock-num">{phase === "trading" ? <Tick v={fmtClock(left)} /> : "–:––"}</span>
            <span className="clock-label">
              {phase === "trading" ? "until the bell" : phase === "dealing" ? "dealing" : phase === "lobby" ? "no deal yet" : "reading"}
            </span>
          </div>
        ) : null}

        {[0, 1, 2, 3].map((i) => (
          <SeatOnStep key={i} t={t} i={i} pos={t ? pitPosition(i, mySeat) : i} mySeat={mySeat} me={me} reveal={reveal} dealFrom={g.dealFrom} />
        ))}
      </section>
      {front ? <div className="pit-front">{front}</div> : null}
    </div>
  );
}

function SeatOnStep({
  t,
  i,
  pos,
  mySeat,
  me,
  reveal,
  dealFrom,
}: {
  t: TableState | null;
  i: number;
  pos: number;
  mySeat: number;
  me: string;
  reveal: (SeatState | null)[] | null;
  dealFrom: [string, string][];
}) {
  const j = JACKETS[i];
  const info = t?.seats[i];
  const kind = !info ? "" : info.kind === "human" ? (info.owner.toBase58() === me ? "you" : "player") : "house bot";
  const phase = t?.phase;
  return (
    <div className={`seat pos-${pos} ${j.cls} ${i === mySeat ? "is-me" : ""} ${t ? "" : "is-empty"}`}>
      <div className="badge">
        <span className="badge-n">{i + 1}</span>
        <span className="badge-txt">
          <b>{j.name}</b>
          <span>{kind || " "}</span>
        </span>
        {t && phase === "settled" ? <span className="badge-rank">{ordinal(t.ranks[i] + 1)}</span> : null}
      </div>

      {t && phase === "trading" ? <PencilQuotes t={t} i={i} /> : null}

      {t && phase === "dealing" ? (
        <span
          className="deal-card"
          aria-hidden="true"
          style={{ "--fx": dealFrom[pos][0], "--fy": dealFrom[pos][1], "--d": `${pos * 110}ms` } as CSSProperties}
        />
      ) : null}

      {t && phase === "settled" ? <FlipCard t={t} i={i} pos={pos} s={reveal?.[i] ?? null} /> : null}
    </div>
  );
}

function PencilQuotes({ t, i }: { t: TableState; i: number }) {
  const lines = [0, 1, 2, 3]
    .map((s) => ({ s, q: pencilQuote(t.bids[s][i], t.asks[s][i]) }))
    .filter((x) => x.q);
  return (
    <ul className="pencil" aria-label={`${JACKETS[i].name} quotes`}>
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

function FlipCard({ t, i, pos, s }: { t: TableState; i: number; pos: number; s: SeatState | null }) {
  return (
    <div className={`card-flip ${s ? "is-open" : ""}`} style={{ "--d": `${pos * 140}ms` } as CSSProperties} data-testid="revealed-seat">
      <div className="card-inner">
        <div className="card-face card-back" aria-hidden={s ? "true" : undefined}>
          <span>{s ? "" : "Opening…"}</span>
        </div>
        <div className="card-face card-front" aria-hidden={s ? undefined : "true"}>
          {s ? (
            <>
              <span className="card-order">
                {s.order.qtyA} <Suit s={s.order.suitA} /> + {s.order.qtyB} <Suit s={s.order.suitB} />
              </span>
              <span className="card-hand">
                {s.hand.map((n, k) => (
                  <span key={k} className={orderRequirement(s.order)[k] > n ? "short" : ""}>
                    <Suit s={k} />
                    {n}
                  </span>
                ))}
              </span>
              <span className="card-foot">
                {s.chips} chips, {t.filled[i] ? "order filled" : "order missed"}
              </span>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

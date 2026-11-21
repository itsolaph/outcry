import { CSSProperties, ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { SUITS, TableState } from "@outcry/client";
import { explorerAddress, explorerTx } from "./config";

export const SUIT_NAME = SUITS;

export type SeatKind = "you" | "player" | "bot";
export const KIND_LABEL: Record<SeatKind, string> = { you: "you", player: "player", bot: "house bot" };

/** Who sits in seat `i`, from the viewer's side: you, another player, or a house bot. */
export function seatKind(t: TableState, i: number, me: string): SeatKind {
  const s = t.seats[i];
  return s.kind === "human" ? (s.owner.toBase58() === me ? "you" : "player") : "bot";
}

/** The four pips, drawn rather than typed so no platform swaps in an emoji. Four-colour deck: the class `s0..s3` sets the colour. */
export function Pip({ s, className = "" }: { s: number; className?: string }) {
  return (
    <svg className={`pip ${className}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {s === 0 ? (
        <path d="M12 2.2C8.6 6.4 2.8 9.6 2.8 14.2c0 2.8 2.1 4.7 4.6 4.7 1.5 0 2.8-.6 3.7-1.7-.2 2-.9 3.4-2.3 4.6h6.4c-1.4-1.2-2.1-2.6-2.3-4.6.9 1.1 2.2 1.7 3.7 1.7 2.5 0 4.6-1.9 4.6-4.7 0-4.6-5.8-7.8-9.2-12z" />
      ) : s === 1 ? (
        <>
          <circle cx="12" cy="7.3" r="4.5" />
          <circle cx="6.9" cy="14.1" r="4.5" />
          <circle cx="17.1" cy="14.1" r="4.5" />
          <circle cx="12" cy="12.3" r="2.8" />
          <path d="M11.3 13.5c0 3.9-.9 6.6-2.7 8.3h6.8c-1.8-1.7-2.7-4.4-2.7-8.3z" />
        </>
      ) : s === 2 ? (
        <path d="M12 21.4C5.4 15.8 2.5 12.4 2.5 8.5c0-3 2.3-5.3 5.1-5.3 1.8 0 3.4.9 4.4 2.4 1-1.5 2.6-2.4 4.4-2.4 2.8 0 5.1 2.3 5.1 5.3 0 3.9-2.9 7.3-9.5 12.9z" />
      ) : (
        <path d="M12 1.8c1.8 3.8 4.5 7.3 7.8 10.2-3.3 2.9-6 6.4-7.8 10.2-1.8-3.8-4.5-7.3-7.8-10.2 3.3-2.9 6-6.4 7.8-10.2z" />
      )}
    </svg>
  );
}

export function Suit({ s, withName = false }: { s: number; withName?: boolean }) {
  return (
    <span className={`suit s${s}`} title={SUIT_NAME[s]}>
      <Pip s={s} />
      {withName ? <span className="suit-name"> {SUIT_NAME[s]}</span> : <span className="sr-only">{SUIT_NAME[s]}</span>}
    </span>
  );
}

/** One playing card, face up. The deck has no ranks, so a face is its suit: a corner pip (with the count when
 *  the card tops a stack) and a large pip. */
export function Card({ s, n, className = "", style }: { s: number; n?: number; className?: string; style?: CSSProperties }) {
  return (
    <span className={`pc s${s} ${n !== undefined ? "pc-top" : ""} ${className}`} style={style} aria-hidden="true">
      <span className="pc-idx">
        {n !== undefined ? <Tick v={n} className="pc-n num" /> : null}
        <Pip s={s} />
      </span>
      <Pip s={s} className="pc-mid" />
      <Pip s={s} className="pc-foot" />
    </span>
  );
}

/** The Outcry mark: the opening bell, a dome with its striker knob on a base plate. */
export function BellMark() {
  return (
    <svg className="bell-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="5" r="1.9" />
      <path d="M11 6h2v2.2h-2z" />
      <path d="M3.5 17a8.5 8.5 0 0 1 17 0z" />
      <rect x="1.5" y="18.5" width="21" height="2.8" rx="1.4" />
    </svg>
  );
}

/** Counts how many times `v` has changed since mount: 0 until the first change, so a flash keyed on it never fires on load. */
export function useChanges(v: unknown): number {
  const ref = useRef({ v, n: 0 });
  if (ref.current.v !== v) ref.current = { v, n: ref.current.n + 1 };
  return ref.current.n;
}

/** A seat is its number in a small circle: filled for you, ink ring for a player, quiet ring for a house bot. */
export function Seat({ seat, kind = "bot" }: { seat: number; kind?: SeatKind }) {
  return (
    <span className={`seat is-${kind}`} title={`Seat ${seat + 1}, ${KIND_LABEL[kind]}`}>
      <span aria-hidden="true">{seat + 1}</span>
      <span className="sr-only">
        seat {seat + 1} ({KIND_LABEL[kind]})
      </span>
    </span>
  );
}

/** A number that ticks when it changes (re-keyed so only a new value animates). */
export function Tick({ v, className = "" }: { v: ReactNode; className?: string }) {
  return (
    <span className={`tick ${className}`} key={String(v)}>
      {v}
    </span>
  );
}

/** A clock set digit by digit, so only the digits that change roll. */
export function Roll({ text }: { text: string }) {
  return (
    <>
      {[...text].map((ch, i) =>
        /[0-9]/.test(ch) ? (
          <span key={i} className="digit">
            <span key={ch} className="digit-in">
              {ch}
            </span>
          </span>
        ) : (
          <span key={i} className="sep">
            {ch}
          </span>
        ),
      )}
    </>
  );
}

/** One seat's quote in one suit: "14 at 22", "9 bid", "at 30". */
export function quoteText(bid: number, ask: number): string | null {
  if (bid && ask) return `${bid} at ${ask}`;
  if (bid) return `${bid} bid`;
  if (ask) return `at ${ask}`;
  return null;
}

export function ordinal(n: number): string {
  return `${n}${["st", "nd", "rd", "th"][Math.min(n, 4) - 1]}`;
}

export function TxLink({ sig, layer, children }: { sig: string; layer: "base" | "er"; children?: ReactNode }) {
  return (
    <a className="txlink" href={explorerTx(sig, layer)} target="_blank" rel="noreferrer" title={`${layer === "er" ? "TEE rollup" : "Solana devnet"} transaction ${sig}`}>
      {children ?? `${sig.slice(0, 8)}…`}
    </a>
  );
}

export function AddrLink({ addr, layer, children }: { addr: string; layer: "base" | "er"; children?: ReactNode }) {
  return (
    <a className="txlink" href={explorerAddress(addr, layer)} target="_blank" rel="noreferrer" title={addr}>
      {children ?? `${addr.slice(0, 4)}…${addr.slice(-4)}`}
    </a>
  );
}

export function fmtClock(secs: number): string {
  const s = Math.max(0, Math.ceil(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function phaseText(t: TableState, now: number): string {
  switch (t.phase) {
    case "lobby":
      return "Waiting for the first deal";
    case "dealing":
      return "Dealing";
    case "trading":
      return `Trading, bell in ${fmtClock(t.tradeEndTs - now)}`;
    case "settled":
      return `Bell rang ${fmtClock(now - t.tradeEndTs)} ago`;
  }
}

// ------------------------------------------------------------------ toasts

export interface Toast {
  id: number;
  kind: "ok" | "bad" | "info";
  text: string;
  sig?: string;
}
let toasts: Toast[] = [];
let nextId = 1;
const tl = new Set<() => void>();
export function toast(kind: Toast["kind"], text: string, sig?: string) {
  const t = { id: nextId++, kind, text, sig };
  toasts = [...toasts.slice(-3), t];
  tl.forEach((l) => l());
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    tl.forEach((l) => l());
  }, kind === "bad" ? 5000 : 3500);
}

export function Toasts() {
  const list = useSyncExternalStore(
    (l) => {
      tl.add(l);
      return () => tl.delete(l);
    },
    () => toasts,
  );
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} data-testid={`toast-${t.kind}`} data-toast-id={t.id}>
          <span className="toast-text" title={t.text}>
            {t.text}
          </span>
          {t.sig ? (
            <>
              {" "}
              <TxLink sig={t.sig} layer="er">View transaction</TxLink>
            </>
          ) : null}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ hash routing

export function useHashRoute(): string {
  const [h, setH] = useState(() => window.location.hash.replace(/^#/, "") || "/");
  useEffect(() => {
    const on = () => setH(window.location.hash.replace(/^#/, "") || "/");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return h;
}

export function go(path: string) {
  window.location.hash = path;
}

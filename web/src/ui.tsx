import { ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { SUITS, TableState } from "@outcry/client";
import { explorerAddress, explorerTx } from "./config";

export const SUIT_GLYPH = ["♠", "♣", "♥", "♦"];
export const SUIT_NAME = SUITS;

export type SeatKind = "you" | "player" | "bot";
export const KIND_LABEL: Record<SeatKind, string> = { you: "you", player: "player", bot: "house bot" };

/** Who sits in seat `i`, from the viewer's side: you, another player, or a house bot. */
export function seatKind(t: TableState, i: number, me: string): SeatKind {
  const s = t.seats[i];
  return s.kind === "human" ? (s.owner.toBase58() === me ? "you" : "player") : "bot";
}

export function Suit({ s, withName = false }: { s: number; withName?: boolean }) {
  return (
    <span className={`suit s${s}`} title={SUIT_NAME[s]}>
      <span className="glyph" aria-hidden="true">
        {SUIT_GLYPH[s]}
      </span>
      {withName ? <span className="suit-name"> {SUIT_NAME[s]}</span> : <span className="sr-only">{SUIT_NAME[s]}</span>}
    </span>
  );
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
      {[...text].map((ch, i) => (
        <span key={`${i}-${ch}`} className={/[0-9]/.test(ch) ? "digit" : "sep"}>
          {ch}
        </span>
      ))}
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

import { ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { SUITS, TableState } from "@outcry/client";
import { explorerAddress, explorerTx } from "./config";
import jacketRed from "./assets/img/jacket-red.webp";
import jacketGreen from "./assets/img/jacket-green.webp";
import jacketGold from "./assets/img/jacket-gold.webp";
import jacketBlue from "./assets/img/jacket-blue.webp";

export const SUIT_GLYPH = ["♠", "♣", "♥", "♦"];
export const SUIT_NAME = SUITS;
/** Trading jackets: each seat wears one colour everywhere in the UI. */
export const JACKETS = [
  { name: "Red", cls: "j0", img: jacketRed },
  { name: "Green", cls: "j1", img: jacketGreen },
  { name: "Gold", cls: "j2", img: jacketGold },
  { name: "Blue", cls: "j3", img: jacketBlue },
];

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

/** A seat's jacket as a small flat tag: colour block with the seat number, then the name. */
export function Jacket({ seat, label }: { seat: number; label?: ReactNode }) {
  return (
    <span className={`jacket ${JACKETS[seat].cls}`}>
      <span className="jacket-n" aria-hidden="true">
        {seat + 1}
      </span>
      {label ?? JACKETS[seat].name}
    </span>
  );
}

/** The jacket photo on its hook, with the seat number set on the blank clip badge. */
export function JacketPortrait({ seat, className = "" }: { seat: number; className?: string }) {
  return (
    <span className={`portrait ${JACKETS[seat].cls} ${className}`} data-n={seat + 1}>
      <img src={JACKETS[seat].img} alt="" width={480} height={480} loading="lazy" decoding="async" />
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

/** Matches a media query (layout-only: picks the pit's drawing shape). */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (l) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", l);
      return () => m.removeEventListener("change", l);
    },
    () => window.matchMedia(query).matches,
  );
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
          {t.text}
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

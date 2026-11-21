import { ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { SUITS, TableState } from "@outcry/client";
import { explorerAddress, explorerTx } from "./config";

export const SUIT_GLYPH = ["♠", "♣", "♥", "♦"];
export const SUIT_NAME = SUITS;
/** Trading jackets: each seat wears one colour everywhere in the UI. */
export const JACKETS = [
  { name: "Red", cls: "j0" },
  { name: "Green", cls: "j1" },
  { name: "Gold", cls: "j2" },
  { name: "Blue", cls: "j3" },
];

export function Suit({ s, withName = false }: { s: number; withName?: boolean }) {
  return (
    <span className={`suit s${s}`} title={SUIT_NAME[s]}>
      <span aria-hidden="true">{SUIT_GLYPH[s]}</span>
      {withName ? <span className="suit-name"> {SUIT_NAME[s]}</span> : <span className="sr-only">{SUIT_NAME[s]}</span>}
    </span>
  );
}

export function Jacket({ seat, label }: { seat: number; label?: ReactNode }) {
  return (
    <span className={`jacket ${JACKETS[seat].cls}`}>
      <span className="jacket-dot" aria-hidden="true" />
      {label ?? JACKETS[seat].name}
    </span>
  );
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
          {t.text}
          {t.sig ? (
            <>
              {" "}
              <TxLink sig={t.sig} layer="er">view</TxLink>
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

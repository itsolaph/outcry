// Every transaction this browser sent (or that the app found), with its layer for explorer links.
import { useSyncExternalStore } from "react";

export interface TxEntry {
  sig: string;
  label: string;
  layer: "base" | "er";
  table?: string;
  round?: number;
  ts: number;
}

const KEY = "outcry.txlog.v1";
let entries: TxEntry[] = load();
const listeners = new Set<() => void>();

function load(): TxEntry[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as TxEntry[];
  } catch {
    return [];
  }
}

export function addTx(e: Omit<TxEntry, "ts">): void {
  if (entries.some((x) => x.sig === e.sig)) return;
  entries = [{ ...e, ts: Date.now() }, ...entries].slice(0, 120);
  localStorage.setItem(KEY, JSON.stringify(entries));
  listeners.forEach((l) => l());
}

export function useTxLog(): TxEntry[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => entries,
  );
}

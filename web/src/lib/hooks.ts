// Live reads: account subscriptions on the TEE RPC with a polling fallback.
import { useEffect, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { PrivateRead, SeatState, TableState, decodeTable } from "@outcry/client";
import { anonEr, client, erNow, myEr } from "./outcry";

/** Re-render every `ms` (countdowns). */
export function useTick(ms = 500): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
  return n;
}

export function useErNow(ms = 500): number {
  useTick(ms);
  return erNow();
}

export interface LiveTable {
  table: TableState | null;
  error: string | null;
  /** "ws" while subscription updates arrive, "poll" when only polling */
  source: "ws" | "poll";
  refresh: () => Promise<TableState | null>;
}

/** One table, live. Subscribes on the ER and polls when the socket has been quiet. */
export function useLiveTable(address: string | null, pollMs = 2500): LiveTable {
  const [table, setTable] = useState<TableState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<"ws" | "poll">("poll");
  const lastWs = useRef(0);
  const refreshRef = useRef<() => Promise<TableState | null>>(async () => null);

  useEffect(() => {
    setTable(null);
    setError(null);
    if (!address) return;
    let alive = true;
    const pk = new PublicKey(address);
    const refresh = async () => {
      try {
        const t = await client.fetchTable(anonEr, pk);
        if (alive) {
          setTable(t);
          setError(null);
        }
        return t;
      } catch (e) {
        if (alive) setError(String((e as Error).message ?? e));
        return null;
      }
    };
    refreshRef.current = refresh;
    let subId: number | null = null;
    try {
      subId = anonEr.onAccountChange(
        pk,
        (info) => {
          try {
            const t = decodeTable(info.data as Buffer);
            lastWs.current = Date.now();
            if (alive) {
              setTable(t);
              setSource("ws");
            }
          } catch {
            // ignore
          }
        },
        { commitment: "confirmed" },
      );
    } catch {
      subId = null;
    }
    refresh();
    const id = setInterval(() => {
      if (Date.now() - lastWs.current > pollMs) {
        setSource("poll");
        refresh();
      }
    }, pollMs);
    return () => {
      alive = false;
      clearInterval(id);
      if (subId !== null) anonEr.removeAccountChangeListener(subId).catch(() => {});
    };
  }, [address, pollMs]);

  return { table, error, source, refresh: () => refreshRef.current() };
}

/** All house tables (lobby): polling only, they are small and public. */
export function useTables(addresses: string[], pollMs = 3000): Record<string, TableState | null> {
  const [map, setMap] = useState<Record<string, TableState | null>>({});
  const key = addresses.join(",");
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const res = await Promise.all(
        addresses.map((a) => client.fetchTable(anonEr, new PublicKey(a)).catch(() => null)),
      );
      if (alive) setMap(Object.fromEntries(addresses.map((a, i) => [a, res[i]])));
    };
    load();
    const id = setInterval(load, pollMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, pollMs]);
  return map;
}

/**
 * My private seat, read with my TEE token. Re-read whenever the table changes (a trade against
 * my quote writes my seat and the tape) and every 2 s as a fallback.
 */
export function useMySeat(address: string | null, seatIndex: number, table: TableState | null): PrivateRead<SeatState> | null {
  const [seat, setSeat] = useState<PrivateRead<SeatState> | null>(null);
  const version = table ? `${table.round}:${table.phase}:${table.tradeCount}:${table.bids.flat().join()}:${table.asks.flat().join()}` : "";
  const read = useRef<() => void>(() => {});
  useEffect(() => {
    if (!address || seatIndex < 0) {
      setSeat(null);
      return;
    }
    let alive = true;
    const pk = new PublicKey(address);
    read.current = async () => {
      try {
        const er = await myEr();
        const r = await client.readSeat(er, pk, seatIndex);
        if (alive) setSeat(r);
      } catch (e) {
        if (alive) setSeat({ visible: false, reason: String((e as Error).message ?? e) });
      }
    };
    read.current();
    const id = setInterval(() => read.current(), 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [address, seatIndex]);
  useEffect(() => {
    read.current();
  }, [version]);
  return seat;
}

/** After the bell every seat is public: read all four anonymously, once per round. */
export function useReveal(address: string | null, table: TableState | null): (SeatState | null)[] | null {
  const [seats, setSeats] = useState<(SeatState | null)[] | null>(null);
  const round = table?.phase === "settled" ? table.round : -1;
  useEffect(() => {
    setSeats(null);
    if (!address || round < 0) return;
    let alive = true;
    let tries = 0;
    const load = async () => {
      const r = await client.fetchRevealedSeats(anonEr, new PublicKey(address));
      const vals = r.map((x) => (x.visible && x.value.round === round ? x.value : null));
      if (!alive) return;
      setSeats(vals);
      if (vals.some((v) => v === null) && tries++ < 10) setTimeout(load, 1500);
    };
    load();
    return () => {
      alive = false;
    };
  }, [address, round]);
  return seats;
}

// Read-side helpers over the public book in `TableState` (one bid and one ask per seat per suit).
import { NUM_SEATS } from "./constants.js";
import { TableState } from "./decode.js";

export interface Level {
  price: number;
  seat: number;
}

/** Highest bid in `suit`, optionally ignoring one seat (e.g. my own). Ties go to the lower seat. */
export function bestBid(t: TableState, suit: number, excludeSeat = -1): Level | null {
  let best: Level | null = null;
  for (let i = 0; i < NUM_SEATS; i++) {
    const p = t.bids[suit][i];
    if (p === 0 || i === excludeSeat) continue;
    if (!best || p > best.price) best = { price: p, seat: i };
  }
  return best;
}

/** Lowest ask in `suit`, optionally ignoring one seat. Ties go to the lower seat. */
export function bestAsk(t: TableState, suit: number, excludeSeat = -1): Level | null {
  let best: Level | null = null;
  for (let i = 0; i < NUM_SEATS; i++) {
    const p = t.asks[suit][i];
    if (p === 0 || i === excludeSeat) continue;
    if (!best || p < best.price) best = { price: p, seat: i };
  }
  return best;
}

/** Seat index owned by `owner` (base58) as a human, or -1. */
export function seatOf(t: TableState, owner: string): number {
  return t.seats.findIndex((s) => s.kind === "human" && s.owner.toBase58() === owner);
}

/** Bot seats a guest could join (only between rounds). */
export function freeSeats(t: TableState): number[] {
  return t.seats.flatMap((s, i) => (s.kind === "bot" ? [i] : []));
}

export function canJoin(t: TableState): boolean {
  return t.phase === "lobby" || t.phase === "settled";
}

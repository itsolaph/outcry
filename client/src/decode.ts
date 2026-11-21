// Decoders for Outcry accounts. `Table` is zero-copy (C layout), `Seat` and `PlayerRecord` are
// Borsh; offsets below mirror programs/outcry/src/state.rs.
import { PublicKey } from "@solana/web3.js";
import { NUM_SEATS, NUM_SUITS, PHASES, Phase, SEAT_HUMAN, TAPE_LEN } from "./constants.js";

export interface SeatInfo {
  kind: "bot" | "human";
  /** Session signer allowed to act for the seat (default key for bots). */
  owner: PublicKey;
  /** Wallet whose PlayerRecord receives the results (default key if none). */
  wallet: PublicKey;
}

export interface TradePrint {
  slot: bigint;
  unixTs: number;
  round: number;
  suit: number;
  price: number;
  buyer: number;
  seller: number;
}

export interface TableState {
  creator: PublicKey;
  tableId: bigint;
  tradeEndTs: number;
  dealRequestedTs: number;
  lastTickSlot: bigint;
  crankTaskId: bigint;
  round: number;
  tradeCount: number;
  tickCount: number;
  recordsRound: number;
  windowSecs: number;
  bump: number;
  phase: Phase;
  seats: SeatInfo[];
  /** bids[suit][seat], 0 = none */
  bids: number[][];
  /** asks[suit][seat], 0 = none */
  asks: number[][];
  scores: number[];
  ranks: number[];
  filled: boolean[];
  /** Tape in chronological order (oldest first), at most 64 prints. */
  tape: TradePrint[];
}

export interface SeatState {
  table: PublicKey;
  index: number;
  bump: number;
  round: number;
  /** Card counts per suit: spades, clubs, hearts, diamonds. */
  hand: number[];
  chips: number;
  order: { suitA: number; qtyA: number; suitB: number; qtyB: number };
}

export interface PlayerRecordState {
  wallet: PublicKey;
  rounds: number;
  ordersFilled: number;
  wins: number;
  bestScore: number;
  totalScore: bigint;
  lastTable: PublicKey;
  lastRound: number;
}

const DISC = 8;
export const TABLE_ACCOUNT_SIZE = DISC + 1968;

export function decodeTable(data: Buffer): TableState {
  if (data.length < TABLE_ACCOUNT_SIZE) throw new Error(`table account too small: ${data.length}`);
  const b = data.subarray(DISC);
  const pk = (o: number) => new PublicKey(b.subarray(o, o + 32));
  const seats: SeatInfo[] = [];
  for (let i = 0; i < NUM_SEATS; i++) {
    const o = 96 + i * 72;
    seats.push({ owner: pk(o), wallet: pk(o + 32), kind: b[o + 64] === SEAT_HUMAN ? "human" : "bot" });
  }
  const grid = (o: number) =>
    Array.from({ length: NUM_SUITS }, (_, s) => Array.from({ length: NUM_SEATS }, (_, i) => b[o + s * NUM_SEATS + i]));
  const tradeCount = b.readUInt32LE(76);
  const raw: TradePrint[] = [];
  for (let i = 0; i < TAPE_LEN; i++) {
    const o = 432 + i * 24;
    raw.push({
      slot: b.readBigUInt64LE(o),
      unixTs: Number(b.readBigInt64LE(o + 8)),
      round: b.readUInt32LE(o + 16),
      suit: b[o + 20],
      price: b[o + 21],
      buyer: b[o + 22],
      seller: b[o + 23],
    });
  }
  const n = Math.min(tradeCount, TAPE_LEN);
  const start = tradeCount > TAPE_LEN ? tradeCount % TAPE_LEN : 0;
  const tape = Array.from({ length: n }, (_, k) => raw[(start + k) % TAPE_LEN]);
  return {
    creator: pk(0),
    tableId: b.readBigUInt64LE(32),
    tradeEndTs: Number(b.readBigInt64LE(40)),
    dealRequestedTs: Number(b.readBigInt64LE(48)),
    lastTickSlot: b.readBigUInt64LE(56),
    crankTaskId: b.readBigInt64LE(64),
    round: b.readUInt32LE(72),
    tradeCount,
    tickCount: b.readUInt32LE(80),
    recordsRound: b.readUInt32LE(84),
    windowSecs: b.readUInt16LE(88),
    bump: b[90],
    phase: PHASES[b[91]] ?? "lobby",
    seats,
    bids: grid(384),
    asks: grid(400),
    scores: [0, 1, 2, 3].map((i) => b.readUInt16LE(416 + 2 * i)),
    ranks: [0, 1, 2, 3].map((i) => b[424 + i]),
    filled: [0, 1, 2, 3].map((i) => b[428 + i] === 1),
    tape,
  };
}

export function decodeSeat(data: Buffer): SeatState {
  const b = data.subarray(DISC);
  return {
    table: new PublicKey(b.subarray(0, 32)),
    index: b[32],
    bump: b[33],
    round: b.readUInt32LE(34),
    hand: [b[38], b[39], b[40], b[41]],
    chips: b.readUInt16LE(42),
    order: { suitA: b[44], qtyA: b[45], suitB: b[46], qtyB: b[47] },
  };
}

export function decodePlayerRecord(data: Buffer): PlayerRecordState {
  const b = data.subarray(DISC);
  return {
    wallet: new PublicKey(b.subarray(0, 32)),
    rounds: b.readUInt32LE(32),
    ordersFilled: b.readUInt32LE(36),
    wins: b.readUInt32LE(40),
    bestScore: b.readUInt16LE(44),
    totalScore: b.readBigUInt64LE(46),
    lastTable: new PublicKey(b.subarray(54, 86)),
    lastRound: b.readUInt32LE(86),
  };
}

/** Required cards per suit for a seat's order. */
export function orderRequirement(order: SeatState["order"]): number[] {
  const r = [0, 0, 0, 0];
  r[order.suitA] += order.qtyA;
  r[order.suitB] += order.qtyB;
  return r;
}

export function orderFilled(seat: SeatState): boolean {
  const r = orderRequirement(seat.order);
  return r.every((need, s) => seat.hand[s] >= need);
}

use anchor_lang::prelude::*;

use crate::game::{OrderSpec, NUM_SEATS, NUM_SUITS};

pub const TABLE_SEED: &[u8] = b"table";
pub const SEAT_SEED: &[u8] = b"seat";
pub const RECORD_SEED: &[u8] = b"record";
pub const TAPE_LEN: usize = 64;

pub const PHASE_LOBBY: u8 = 0;
pub const PHASE_DEALING: u8 = 1;
pub const PHASE_TRADING: u8 = 2;
pub const PHASE_SETTLED: u8 = 3;

pub const SEAT_BOT: u8 = 0;
pub const SEAT_HUMAN: u8 = 1;

/// Public roster entry for one seat.
#[zero_copy]
#[derive(Default)]
pub struct SeatInfo {
    /// Signer allowed to act for this seat (session key). Default for bots.
    pub owner: Pubkey,
    /// Wallet whose base-layer `PlayerRecord` receives this seat's results. Default if none.
    pub wallet: Pubkey,
    pub kind: u8,
    pub _pad: [u8; 7],
}

/// One fill on the public tape.
#[zero_copy]
#[derive(Default)]
pub struct Trade {
    pub slot: u64,
    pub unix_ts: i64,
    pub round: u32,
    pub suit: u8,
    pub price: u8,
    pub buyer: u8,
    pub seller: u8,
}

/// Public table state. Delegated to the TEE validator once and reused round after round.
/// Zero-copy so the 64-entry tape never lands on the BPF stack.
#[account(zero_copy)]
pub struct Table {
    pub creator: Pubkey,
    pub table_id: u64,
    /// Trading closes at this ER unix timestamp.
    pub trade_end_ts: i64,
    /// When the current deal's VRF request was sent (for retry after a lost callback).
    pub deal_requested_ts: i64,
    /// Last slot a `bot_tick` ran (rate limit for the permissionless tick).
    pub last_tick_slot: u64,
    /// Task id of the crank scheduled for the current round.
    pub crank_task_id: i64,
    pub round: u32,
    /// Total fills ever written to the tape (the ring index is `trade_count % TAPE_LEN`).
    pub trade_count: u32,
    pub tick_count: u32,
    /// Last round whose results were sent to the base-layer player records.
    pub records_round: u32,
    pub window_secs: u16,
    pub bump: u8,
    pub phase: u8,
    pub _pad0: [u8; 4],
    pub seats: [SeatInfo; NUM_SEATS],
    /// `bids[suit][seat]` resting bid price, 0 = none.
    pub bids: [[u8; NUM_SEATS]; NUM_SUITS],
    /// `asks[suit][seat]` resting ask price, 0 = none.
    pub asks: [[u8; NUM_SEATS]; NUM_SUITS],
    /// Filled in by the bell.
    pub scores: [u16; NUM_SEATS],
    pub ranks: [u8; NUM_SEATS],
    pub filled: [u8; NUM_SEATS],
    pub tape: [Trade; TAPE_LEN],
}

impl Table {
    pub const SPACE: usize = 8 + core::mem::size_of::<Table>();

    pub fn push_trade(&mut self, t: Trade) {
        let idx = (self.trade_count as usize) % TAPE_LEN;
        self.tape[idx] = t;
        self.trade_count = self.trade_count.wrapping_add(1);
    }

    pub fn clear_book(&mut self) {
        self.bids = [[0; NUM_SEATS]; NUM_SUITS];
        self.asks = [[0; NUM_SEATS]; NUM_SUITS];
    }
}

/// Private per-seat state: hand, chips and secret order. Readable only by the seat owner
/// (ephemeral permission) until the bell flips it public.
#[account]
#[derive(InitSpace)]
pub struct Seat {
    pub table: Pubkey,
    pub index: u8,
    pub bump: u8,
    /// Round these cards belong to.
    pub round: u32,
    pub hand: [u8; NUM_SUITS],
    pub chips: u16,
    pub order_suit_a: u8,
    pub order_qty_a: u8,
    pub order_suit_b: u8,
    pub order_qty_b: u8,
}

impl Seat {
    pub fn order(&self) -> OrderSpec {
        OrderSpec {
            suit_a: self.order_suit_a,
            qty_a: self.order_qty_a,
            suit_b: self.order_suit_b,
            qty_b: self.order_qty_b,
        }
    }

    pub fn set_order(&mut self, o: &OrderSpec) {
        self.order_suit_a = o.suit_a;
        self.order_qty_a = o.qty_a;
        self.order_suit_b = o.suit_b;
        self.order_qty_b = o.qty_b;
    }
}

/// Lifetime stats of one wallet. Lives on the base layer, never delegated; written by a
/// Magic Action scheduled from the ER after each bell.
#[account]
#[derive(InitSpace)]
pub struct PlayerRecord {
    pub wallet: Pubkey,
    pub rounds: u32,
    pub orders_filled: u32,
    pub wins: u32,
    pub best_score: u16,
    pub total_score: u64,
    /// Idempotency key of the last applied result.
    pub last_table: Pubkey,
    pub last_round: u32,
    pub bump: u8,
}

/// One seat's result as carried by the record action.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct RecordEntry {
    pub present: bool,
    pub wallet: Pubkey,
    pub score: u16,
    pub filled: bool,
    pub won: bool,
}

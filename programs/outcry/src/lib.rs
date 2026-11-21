//! Outcry: a real-time, 4-seat open-outcry card-trading table on a MagicBlock Private
//! Ephemeral Rollup (TEE). Hands and secret orders are private per seat (ephemeral
//! permissions), the deal comes from VRF requested inside the ER, bots act on-chain through a
//! native ER crank, and lifetime stats are written to base-layer records by a Magic Action.
#![allow(unexpected_cfgs)]
#![allow(deprecated)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::system_program::{transfer, Transfer};
use ephemeral_rollups_sdk::{
    access_control::{
        instructions::{
            CloseEphemeralPermissionCpi, CreateEphemeralPermissionCpi,
            UpdateEphemeralPermissionCpi,
        },
        structs::{EphemeralMembersArgs, EphemeralPermission, Member, PERMISSION_SEED},
    },
    anchor::{action, commit, delegate, ephemeral, vrf, vrf_callback},
    consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID},
    cpi::DelegateConfig,
    crank::{ScheduleCrankCpi, ScheduleTaskArgs},
    ephem::{CallHandler, MagicIntentBundleBuilder},
    vrf::{
        self,
        consts::program_identity_pubkey,
        instructions::{create_request_randomness_ix_const, RequestRandomnessParams},
        types::SerializableAccountMeta,
    },
    ActionArgs, ShortAccountMeta,
};

pub mod game;
pub mod state;

use game::*;
use state::*;

declare_id!("AUnuoAP1BoujRzy4SSPeiJLoiWKPPsHrAcFqcsiSyWVv");

const PROGRAM_IDENTITY: Pubkey = program_identity_pubkey(&crate::ID);
/// Scoped identity the VRF program signs callbacks with, computed at compile time.
pub const VRF_PROGRAM_IDENTITY: Pubkey =
    Pubkey::new_from_array(vrf::consts::scoped_vrf_identity_const(&crate::ID).0);
/// Members a seat permission can ever hold (the seat owner). Pre-funded with one spare.
const MAX_PERMISSION_MEMBERS: usize = 2;
/// Bot ticks closer together than this are ignored (the tick is permissionless).
pub const MIN_TICK_SLOTS: u64 = 8;
/// Crank cadence for `bot_tick`.
pub const TICK_INTERVAL_MS: i64 = 1_000;
/// A deal whose VRF callback has not arrived after this long may be re-requested.
pub const DEAL_RETRY_SECS: i64 = 20;
pub const MIN_WINDOW_SECS: u16 = 15;
pub const MAX_WINDOW_SECS: u16 = 600;
/// Escrow index used by `ActionArgs::new`.
pub const ACTION_ESCROW_INDEX: u8 = 255;
const RECORD_ACTION_CU: u32 = 120_000;

#[error_code]
pub enum OutcryError {
    #[msg("Seat index out of range")]
    BadSeat,
    #[msg("Suit out of range")]
    BadSuit,
    #[msg("Side must be 0 (bid) or 1 (ask)")]
    BadSide,
    #[msg("Price must be 1..=99")]
    BadPrice,
    #[msg("Signer does not own this seat")]
    NotSeatOwner,
    #[msg("Trading is closed")]
    TradingClosed,
    #[msg("Seller does not hold a card of that suit")]
    NoCard,
    #[msg("Buyer does not hold enough chips")]
    NoChips,
    #[msg("Quote would cross your own quote")]
    SelfCross,
    #[msg("Cannot trade against your own quote")]
    SelfTrade,
    #[msg("No resting quote there")]
    NoQuote,
    #[msg("Round is in progress")]
    RoundInProgress,
    #[msg("Seat already taken by a player")]
    SeatTaken,
    #[msg("Signer already sits at this table")]
    AlreadySeated,
    #[msg("Trading window has not ended")]
    BellTooEarly,
    #[msg("Only a seated player or the table creator may do this")]
    NotAllowed,
    #[msg("Window must be 15..=600 seconds")]
    BadWindow,
    #[msg("Records for this round were already published")]
    AlreadyPublished,
    #[msg("Seat account does not match the table/index")]
    SeatMismatch,
}

#[ephemeral]
#[program]
pub mod outcry {
    use super::*;

    // ------------------------------------------------------------------ base layer

    /// Base: create a table and its four private seats. Seats are pre-funded so they can pay
    /// their own ephemeral-permission rent on the ER.
    pub fn create_table(ctx: Context<CreateTable>, table_id: u64, window_secs: u16) -> Result<()> {
        require!(
            (MIN_WINDOW_SECS..=MAX_WINDOW_SECS).contains(&window_secs),
            OutcryError::BadWindow
        );
        let table_key = ctx.accounts.table.key();
        let perm_rent = ephemeral_rollups_sdk::ephemeral_accounts::rent(
            EphemeralPermission::size_of(MAX_PERMISSION_MEMBERS) as u32,
        );
        let seats = [
            (&mut ctx.accounts.seat0, ctx.bumps.seat0),
            (&mut ctx.accounts.seat1, ctx.bumps.seat1),
            (&mut ctx.accounts.seat2, ctx.bumps.seat2),
            (&mut ctx.accounts.seat3, ctx.bumps.seat3),
        ];
        for (i, (seat, bump)) in seats.into_iter().enumerate() {
            transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    Transfer {
                        from: ctx.accounts.creator.to_account_info(),
                        to: seat.to_account_info(),
                    },
                ),
                perm_rent,
            )?;
            seat.table = table_key;
            seat.index = i as u8;
            seat.bump = bump;
        }
        let mut t = ctx.accounts.table.load_init()?;
        t.creator = ctx.accounts.creator.key();
        t.table_id = table_id;
        t.window_secs = window_secs;
        t.bump = ctx.bumps.table;
        t.phase = PHASE_LOBBY;
        Ok(())
    }

    /// Base: delegate the table to the TEE validator (once; the table is then reused).
    pub fn delegate_table(ctx: Context<DelegateTable>, table_id: u64) -> Result<()> {
        let creator = ctx.accounts.creator.key();
        let id = table_id.to_le_bytes();
        ctx.accounts.delegate_table(
            &ctx.accounts.creator,
            &[TABLE_SEED, creator.as_ref(), &id],
            DelegateConfig {
                validator: ctx.accounts.validator.as_ref().map(|v| v.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Base: delegate one seat to the TEE validator.
    pub fn delegate_seat(ctx: Context<DelegateSeat>, index: u8, _table_id: u64) -> Result<()> {
        require!((index as usize) < NUM_SEATS, OutcryError::BadSeat);
        let table = ctx.accounts.table.key();
        ctx.accounts.delegate_seat(
            &ctx.accounts.creator,
            &[SEAT_SEED, table.as_ref(), &[index]],
            DelegateConfig {
                validator: ctx.accounts.validator.as_ref().map(|v| v.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Base: create the lifetime record of a wallet (anyone may pay for it).
    pub fn init_record(ctx: Context<InitRecord>) -> Result<()> {
        let r = &mut ctx.accounts.record;
        r.wallet = ctx.accounts.wallet.key();
        r.bump = ctx.bumps.record;
        Ok(())
    }

    /// Base, Magic Action only: apply one round's results to the players' records. The escrow
    /// signer proves the delegation program dispatched it, and binding `escrow_auth` to the
    /// table PDA proves this program scheduled it for that table. Idempotent per (table, round).
    pub fn record_round(
        ctx: Context<RecordRound>,
        _creator: Pubkey,
        _table_id: u64,
        round: u32,
        entries: [RecordEntry; NUM_SEATS],
    ) -> Result<()> {
        let table = ctx.accounts.escrow_auth.key();
        let infos = [
            ctx.accounts.record0.to_account_info(),
            ctx.accounts.record1.to_account_info(),
            ctx.accounts.record2.to_account_info(),
            ctx.accounts.record3.to_account_info(),
        ];
        for (entry, info) in entries.iter().zip(infos.iter()) {
            if !entry.present || info.owner != &crate::ID || info.data_is_empty() {
                continue;
            }
            let mut rec = {
                let data = info.try_borrow_data()?;
                match PlayerRecord::try_deserialize(&mut &data[..]) {
                    Ok(r) => r,
                    Err(_) => continue,
                }
            };
            let expected =
                Pubkey::create_program_address(&[RECORD_SEED, rec.wallet.as_ref(), &[rec.bump]], &crate::ID)
                    .map_err(|_| error!(OutcryError::SeatMismatch))?;
            if expected != info.key() || rec.wallet != entry.wallet {
                continue;
            }
            if rec.last_table == table && rec.last_round >= round {
                continue;
            }
            rec.rounds = rec.rounds.saturating_add(1);
            rec.total_score = rec.total_score.saturating_add(entry.score as u64);
            if entry.filled {
                rec.orders_filled = rec.orders_filled.saturating_add(1);
            }
            if entry.won {
                rec.wins = rec.wins.saturating_add(1);
            }
            rec.best_score = rec.best_score.max(entry.score);
            rec.last_table = table;
            rec.last_round = round;
            let mut data = info.try_borrow_mut_data()?;
            rec.try_serialize(&mut &mut data[..])?;
        }
        Ok(())
    }

    // ------------------------------------------------------------------ ER: setup

    /// ER: create the four seat permissions (private, no members yet). Idempotent.
    pub fn init_permissions(ctx: Context<SeatPermissions>) -> Result<()> {
        let table = ctx.accounts.table.key();
        let a = &ctx.accounts;
        let seats = [&a.seat0, &a.seat1, &a.seat2, &a.seat3];
        let perms = [&a.permission0, &a.permission1, &a.permission2, &a.permission3];
        for i in 0..NUM_SEATS {
            check_seat(&seats[i], &table, i)?;
            if perms[i].lamports() > 0 {
                continue;
            }
            let bump = [seats[i].bump];
            let idx = [i as u8];
            let seeds: &[&[u8]] = &[SEAT_SEED, table.as_ref(), &idx, &bump];
            CreateEphemeralPermissionCpi {
                payer: seats[i].to_account_info(),
                permissioned_account: seats[i].to_account_info(),
                permission: perms[i].to_account_info(),
                vault: a.ephemeral_vault.to_account_info(),
                magic_program: a.magic_program.to_account_info(),
                permission_program: a.permission_program.to_account_info(),
                args: EphemeralMembersArgs {
                    is_private: true,
                    members: vec![],
                },
            }
            .invoke_signed(&[seeds])?;
        }
        Ok(())
    }

    /// ER: change the trading window (creator only, between rounds).
    pub fn set_window(ctx: Context<CreatorOnly>, window_secs: u16) -> Result<()> {
        require!(
            (MIN_WINDOW_SECS..=MAX_WINDOW_SECS).contains(&window_secs),
            OutcryError::BadWindow
        );
        let mut t = ctx.accounts.table.load_mut()?;
        require_keys_eq!(t.creator, ctx.accounts.signer.key(), OutcryError::NotAllowed);
        require!(
            t.phase == PHASE_LOBBY || t.phase == PHASE_SETTLED,
            OutcryError::RoundInProgress
        );
        t.window_secs = window_secs;
        Ok(())
    }

    /// ER: take a bot seat. `wallet` (optional co-signer) binds the seat to a base-layer
    /// `PlayerRecord`; without it the seat plays anonymously.
    pub fn join(ctx: Context<Join>, seat_index: u8) -> Result<()> {
        let i = seat_index as usize;
        require!(i < NUM_SEATS, OutcryError::BadSeat);
        let signer = ctx.accounts.signer.key();
        let mut t = ctx.accounts.table.load_mut()?;
        require!(
            t.phase == PHASE_LOBBY || t.phase == PHASE_SETTLED,
            OutcryError::RoundInProgress
        );
        require!(t.seats[i].kind == SEAT_BOT, OutcryError::SeatTaken);
        require!(
            !t.seats.iter().any(|s| s.kind == SEAT_HUMAN && s.owner == signer),
            OutcryError::AlreadySeated
        );
        t.seats[i] = SeatInfo {
            owner: signer,
            wallet: ctx.accounts.wallet.as_ref().map(|w| w.key()).unwrap_or_default(),
            kind: SEAT_HUMAN,
            _pad: [0; 7],
        };
        Ok(())
    }

    /// ER: give a seat back to the house bot (any time; a bot finishes the hand).
    pub fn leave(ctx: Context<Leave>, seat_index: u8) -> Result<()> {
        let i = seat_index as usize;
        require!(i < NUM_SEATS, OutcryError::BadSeat);
        let mut t = ctx.accounts.table.load_mut()?;
        require!(
            t.seats[i].kind == SEAT_HUMAN && t.seats[i].owner == ctx.accounts.signer.key(),
            OutcryError::NotSeatOwner
        );
        t.seats[i] = SeatInfo::default();
        Ok(())
    }

    // ------------------------------------------------------------------ ER: round

    /// ER: start a round. Seals every seat (private permission, owner as the only member),
    /// requests VRF from the ephemeral queue, and optionally schedules the bot/bell crank.
    pub fn start_round<'info>(ctx: Context<'info, StartRound<'info>>, use_crank: bool) -> Result<()> {
        let a: &'info mut StartRound<'info> = ctx.accounts;
        let table_key = a.table.key();
        let signer = a.signer.key();
        let now = Clock::get()?.unix_timestamp;
        let slot = Clock::get()?.slot;
        let (round, members, window_secs) = {
            let mut t = a.table.load_mut()?;
            let seated = t.seats.iter().any(|s| s.kind == SEAT_HUMAN && s.owner == signer);
            require!(seated || t.creator == signer, OutcryError::NotAllowed);
            let retry = t.phase == PHASE_DEALING && now >= t.deal_requested_ts + DEAL_RETRY_SECS;
            require!(
                t.phase == PHASE_LOBBY || t.phase == PHASE_SETTLED || retry,
                OutcryError::RoundInProgress
            );
            if !retry {
                t.round = t.round.wrapping_add(1);
            }
            t.phase = PHASE_DEALING;
            t.deal_requested_ts = now;
            t.trade_end_ts = 0;
            t.clear_book();
            t.scores = [0; NUM_SEATS];
            t.ranks = [0; NUM_SEATS];
            t.filled = [0; NUM_SEATS];
            let mut members: [Option<Pubkey>; NUM_SEATS] = [None; NUM_SEATS];
            for i in 0..NUM_SEATS {
                if t.seats[i].kind == SEAT_HUMAN {
                    members[i] = Some(t.seats[i].owner);
                }
            }
            (t.round, members, t.window_secs)
        };

        // Seal and clear every seat before any card is written.
        {
            let seats = [&mut a.seat0, &mut a.seat1, &mut a.seat2, &mut a.seat3];
            for (i, seat) in seats.into_iter().enumerate() {
                check_seat(seat, &table_key, i)?;
                seat.round = round;
                seat.hand = [0; NUM_SUITS];
                seat.chips = 0;
                seat.set_order(&OrderSpec::default());
            }
        }
        let a: &'info StartRound<'info> = a;
        let seat_infos = [
            a.seat0.to_account_info(),
            a.seat1.to_account_info(),
            a.seat2.to_account_info(),
            a.seat3.to_account_info(),
        ];
        let perm_infos = [
            a.permission0.to_account_info(),
            a.permission1.to_account_info(),
            a.permission2.to_account_info(),
            a.permission3.to_account_info(),
        ];
        let bumps = [a.seat0.bump, a.seat1.bump, a.seat2.bump, a.seat3.bump];
        for i in 0..NUM_SEATS {
            set_seat_permission(
                &seat_infos[i],
                &perm_infos[i],
                &a.permission_program.to_account_info(),
                &a.ephemeral_vault.to_account_info(),
                &a.magic_program.to_account_info(),
                &table_key,
                i as u8,
                bumps[i],
                true,
                members[i],
            )?;
        }

        // VRF from the delegated (ephemeral) queue; the callback deals.
        let mut caller_seed = [0u8; 32];
        caller_seed[..32].copy_from_slice(table_key.as_ref());
        caller_seed[0] ^= round as u8;
        caller_seed[1] ^= (round >> 8) as u8;
        caller_seed[2..10]
            .iter_mut()
            .zip(slot.to_le_bytes())
            .for_each(|(c, s)| *c ^= s);
        let mut callback_accounts = vec![SerializableAccountMeta {
            pubkey: table_key,
            is_signer: false,
            is_writable: true,
        }];
        for s in seat_infos.iter() {
            callback_accounts.push(SerializableAccountMeta {
                pubkey: s.key(),
                is_signer: false,
                is_writable: true,
            });
        }
        let vrf_ix = create_request_randomness_ix_const(
            RequestRandomnessParams {
                payer: signer,
                oracle_queue: a.oracle_queue.key(),
                callback_program_id: crate::ID,
                callback_discriminator: crate::instruction::Deal::DISCRIMINATOR.to_vec(),
                caller_seed,
                accounts_metas: Some(callback_accounts),
                callback_args: Some(round.to_le_bytes().to_vec()),
                ..Default::default()
            },
            PROGRAM_IDENTITY,
        );
        a.invoke_signed_vrf(&a.signer.to_account_info(), &vrf_ix)?;

        if use_crank {
            let task_id = crank_task_id(&table_key, round);
            let mut metas = vec![AccountMeta::new(table_key, false)];
            for s in seat_infos.iter() {
                metas.push(AccountMeta::new(s.key(), false));
            }
            for p in perm_infos.iter() {
                metas.push(AccountMeta::new(p.key(), false));
            }
            metas.push(AccountMeta::new_readonly(PERMISSION_PROGRAM_ID, false));
            metas.push(AccountMeta::new(EPHEMERAL_VAULT_ID, false));
            metas.push(AccountMeta::new_readonly(MAGIC_PROGRAM_ID, false));
            let tick_ix = Instruction {
                program_id: crate::ID,
                accounts: metas,
                data: anchor_lang::InstructionData::data(&crate::instruction::BotTick {}),
            };
            let mut instruction_accounts = vec![a.table.to_account_info()];
            instruction_accounts.extend(seat_infos.iter().cloned());
            instruction_accounts.extend(perm_infos.iter().cloned());
            instruction_accounts.push(a.permission_program.to_account_info());
            instruction_accounts.push(a.ephemeral_vault.to_account_info());
            instruction_accounts.push(a.magic_program.to_account_info());
            ScheduleCrankCpi {
                payer: &a.signer,
                magic_program: &a.magic_program,
                instruction_accounts: &instruction_accounts,
                args: ScheduleTaskArgs {
                    task_id,
                    execution_interval_millis: TICK_INTERVAL_MS,
                    iterations: window_secs as i64 + 45,
                    instructions: vec![tick_ix],
                },
            }
            .invoke()?;
            a.table.load_mut()?.crank_task_id = task_id;
        }
        Ok(())
    }

    /// ER, VRF callback: deal the round. Bound to the round it was requested for; a late or
    /// duplicate callback is a no-op.
    pub fn deal(ctx: Context<DealCtx>, randomness: [u8; 32], round: u32) -> Result<()> {
        let table_key = ctx.accounts.table.key();
        let now = Clock::get()?.unix_timestamp;
        let a = &mut *ctx.accounts;
        let mut t = a.table.load_mut()?;
        if t.phase != PHASE_DEALING || t.round != round {
            msg!("stale deal callback ignored");
            return Ok(());
        }
        let d = game::deal(&randomness);
        let seats = [&mut a.seat0, &mut a.seat1, &mut a.seat2, &mut a.seat3];
        for (i, seat) in seats.into_iter().enumerate() {
            check_seat(seat, &table_key, i)?;
            seat.round = round;
            seat.hand = d.hands[i];
            seat.chips = START_CHIPS;
            seat.set_order(&d.orders[i]);
        }
        t.phase = PHASE_TRADING;
        t.trade_end_ts = now + t.window_secs as i64;
        t.clear_book();
        Ok(())
    }

    /// ER: post or replace own quote. `side` 0 = bid, 1 = ask.
    pub fn quote(ctx: Context<Act>, seat_index: u8, suit: u8, side: u8, price: u8) -> Result<()> {
        let table_key = ctx.accounts.table.key();
        let mut t = ctx.accounts.table.load_mut()?;
        let seat = &ctx.accounts.seat;
        let i = authorize(&t, seat, &table_key, seat_index, &ctx.accounts.signer.key())?;
        trading_open(&t, seat)?;
        place_quote(&mut t, seat, i, suit, side, price)
    }

    /// ER: remove own quote.
    pub fn cancel(ctx: Context<Act>, seat_index: u8, suit: u8, side: u8) -> Result<()> {
        let table_key = ctx.accounts.table.key();
        let mut t = ctx.accounts.table.load_mut()?;
        let seat = &ctx.accounts.seat;
        let i = authorize(&t, seat, &table_key, seat_index, &ctx.accounts.signer.key())?;
        trading_open(&t, seat)?;
        require!((suit as usize) < NUM_SUITS, OutcryError::BadSuit);
        match side {
            SIDE_BID => t.bids[suit as usize][i] = 0,
            SIDE_ASK => t.asks[suit as usize][i] = 0,
            _ => return err!(OutcryError::BadSide),
        }
        Ok(())
    }

    /// ER: trade one card against `counterparty`'s resting quote on `side` of `suit`, at its
    /// price. Taking an ask buys; taking a bid sells.
    pub fn take(ctx: Context<Take>, seat_index: u8, suit: u8, side: u8, counterparty: u8) -> Result<()> {
        let table_key = ctx.accounts.table.key();
        let slot = Clock::get()?.slot;
        let now = Clock::get()?.unix_timestamp;
        let a = &mut *ctx.accounts;
        let mut t = a.table.load_mut()?;
        let i = authorize(&t, &a.seat, &table_key, seat_index, &a.signer.key())?;
        trading_open(&t, &a.seat)?;
        let j = counterparty as usize;
        require!(j < NUM_SEATS, OutcryError::BadSeat);
        require!(j != i, OutcryError::SelfTrade);
        check_seat(&a.counter_seat, &table_key, j)?;
        execute_take(&mut t, &mut a.seat, &mut a.counter_seat, i, j, suit, side, slot, now)
    }

    /// ER: ring the bell once the window has ended (anyone). Scores, ranks, then flips every
    /// seat permission public for the reveal.
    pub fn ring_bell(ctx: Context<Settle>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        {
            let t = ctx.accounts.table.load()?;
            require!(t.phase == PHASE_TRADING, OutcryError::TradingClosed);
            require!(now >= t.trade_end_ts, OutcryError::BellTooEarly);
        }
        settle(ctx.accounts)
    }

    /// ER: one bot step (permissionless, rate limited; normally driven by the crank). Rings
    /// the bell when the window is over. Bots read only their own seat and the public book.
    pub fn bot_tick(ctx: Context<Settle>) -> Result<()> {
        let table_key = ctx.accounts.table.key();
        let clock = Clock::get()?;
        let (phase, end, last, tick) = {
            let t = ctx.accounts.table.load()?;
            (t.phase, t.trade_end_ts, t.last_tick_slot, t.tick_count)
        };
        if phase != PHASE_TRADING {
            return Ok(());
        }
        if clock.unix_timestamp >= end {
            return settle(ctx.accounts);
        }
        if last != 0 && clock.slot < last.saturating_add(MIN_TICK_SLOTS) {
            return Ok(());
        }
        let a = &mut *ctx.accounts;
        let mut t = a.table.load_mut()?;
        t.last_tick_slot = clock.slot;
        t.tick_count = tick.wrapping_add(1);
        let Some(bot) = (0..NUM_SEATS)
            .map(|k| (tick as usize + k) % NUM_SEATS)
            .find(|&s| t.seats[s].kind == SEAT_BOT)
        else {
            return Ok(());
        };
        let mut seats = [&mut a.seat0, &mut a.seat1, &mut a.seat2, &mut a.seat3];
        for (i, s) in seats.iter().enumerate() {
            check_seat(s, &table_key, i)?;
        }
        if seats[bot].round != t.round {
            return Ok(());
        }
        let action = {
            let me = &seats[bot];
            bot_decide(&BotView {
                seat: bot as u8,
                hand: me.hand,
                chips: me.chips,
                order: me.order(),
                bids: &t.bids,
                asks: &t.asks,
            })
        };
        match action {
            BotAction::Take { suit, side, counterparty } => {
                let j = counterparty as usize;
                let (mine, theirs) = pick_two(&mut seats, bot, j);
                execute_take(&mut t, mine, theirs, bot, j, suit, side, clock.slot, clock.unix_timestamp)?;
            }
            BotAction::Quote { bids, asks } => {
                for s in 0..NUM_SUITS {
                    t.bids[s][bot] = bids[s];
                    t.asks[s][bot] = asks[s];
                }
            }
            BotAction::Idle => {}
        }
        Ok(())
    }

    /// ER: retire the table (creator only, between rounds). Closes the four seat permissions
    /// (rent back to the seats), then commits and undelegates the table and seats to base.
    pub fn undelegate_table(ctx: Context<CloseOut>) -> Result<()> {
        let table_key = ctx.accounts.table.key();
        {
            let t = ctx.accounts.table.load()?;
            require_keys_eq!(t.creator, ctx.accounts.payer.key(), OutcryError::NotAllowed);
            require!(
                t.phase == PHASE_LOBBY || t.phase == PHASE_SETTLED,
                OutcryError::RoundInProgress
            );
        }
        let a = &ctx.accounts;
        let seats = [&a.seat0, &a.seat1, &a.seat2, &a.seat3];
        let perms = [&a.permission0, &a.permission1, &a.permission2, &a.permission3];
        for i in 0..NUM_SEATS {
            check_seat(seats[i], &table_key, i)?;
            if perms[i].lamports() == 0 {
                continue;
            }
            let idx = [i as u8];
            let b = [seats[i].bump];
            let seeds: &[&[u8]] = &[SEAT_SEED, table_key.as_ref(), &idx, &b];
            CloseEphemeralPermissionCpi {
                payer: seats[i].to_account_info(),
                permissioned_account: seats[i].to_account_info(),
                permission: perms[i].to_account_info(),
                vault: a.ephemeral_vault.to_account_info(),
                magic_program: a.magic_program.to_account_info(),
                permission_program: a.permission_program.to_account_info(),
                authority: seats[i].to_account_info(),
                authority_is_signer: false,
            }
            .invoke_signed(&[seeds])?;
        }
        MagicIntentBundleBuilder::new(
            a.payer.to_account_info(),
            a.magic_context.to_account_info(),
            a.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[
            a.table.to_account_info(),
            a.seat0.to_account_info(),
            a.seat1.to_account_info(),
            a.seat2.to_account_info(),
            a.seat3.to_account_info(),
        ])
        .build_and_invoke()?;
        Ok(())
    }

    /// ER: send this round's results to the base-layer player records through a standalone
    /// Magic Action (no commit, so no commit nonce is consumed). Anyone may call it once per
    /// round after the bell; the caller is the intent payer.
    pub fn publish_records(ctx: Context<PublishRecords>) -> Result<()> {
        let table_key = ctx.accounts.table.key();
        let (creator, table_id, round, bump, entries) = {
            let mut t = ctx.accounts.table.load_mut()?;
            require!(t.phase == PHASE_SETTLED, OutcryError::RoundInProgress);
            require!(t.records_round < t.round, OutcryError::AlreadyPublished);
            t.records_round = t.round;
            let mut entries = [RecordEntry::default(); NUM_SEATS];
            for i in 0..NUM_SEATS {
                let s = &t.seats[i];
                if s.kind == SEAT_HUMAN && s.wallet != Pubkey::default() {
                    entries[i] = RecordEntry {
                        present: true,
                        wallet: s.wallet,
                        score: t.scores[i],
                        filled: t.filled[i] == 1,
                        won: t.ranks[i] == 0,
                    };
                }
            }
            (t.creator, t.table_id, t.round, t.bump, entries)
        };
        let accounts = (0..NUM_SEATS)
            .map(|i| ShortAccountMeta {
                pubkey: record_slot(&entries[i], &table_key, i as u8).to_bytes().into(),
                is_writable: true,
            })
            .collect::<Vec<_>>();
        let data = anchor_lang::InstructionData::data(&crate::instruction::RecordRound {
            _creator: creator,
            _table_id: table_id,
            round,
            entries,
        });
        // The magic program requires the escrow authority to be a signer of the scheduling CPI.
        // The intent builder copies `is_signer` from the AccountInfo (it only forces the payer),
        // so mark the table PDA as a signer here; `build_and_invoke_signed` supplies its seeds.
        let mut escrow_authority = ctx.accounts.table.to_account_info();
        escrow_authority.is_signer = true;
        let action = CallHandler {
            destination_program: crate::ID,
            accounts,
            args: ActionArgs::new(data),
            escrow_authority,
            compute_units: RECORD_ACTION_CU,
        };
        let id = table_id.to_le_bytes();
        let seeds: &[&[u8]] = &[TABLE_SEED, creator.as_ref(), &id, &[bump]];
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .add_standalone_actions([action])
        .build_and_invoke_signed(&[seeds])?;
        Ok(())
    }
}

// ---------------------------------------------------------------------- helpers

/// Record account the action writes for seat `i`: the wallet's record PDA, or a per-seat
/// placeholder address (never initialized, skipped by the handler) for bots/anonymous seats.
pub fn record_slot(entry: &RecordEntry, table: &Pubkey, i: u8) -> Pubkey {
    if entry.present {
        Pubkey::find_program_address(&[RECORD_SEED, entry.wallet.as_ref()], &crate::ID).0
    } else {
        Pubkey::find_program_address(&[RECORD_SEED, table.as_ref(), &[i]], &crate::ID).0
    }
}

/// Crank task ids are validator-global on 1.x: derive one from the table and round.
pub fn crank_task_id(table: &Pubkey, round: u32) -> i64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&table.as_ref()[..8]);
    let v = u64::from_le_bytes(b) ^ ((round as u64) << 24);
    (v >> 2) as i64
}

fn check_seat(seat: &Account<Seat>, table: &Pubkey, i: usize) -> Result<()> {
    require!(
        seat.table == *table && seat.index as usize == i,
        OutcryError::SeatMismatch
    );
    Ok(())
}

fn authorize(t: &Table, seat: &Account<Seat>, table: &Pubkey, seat_index: u8, signer: &Pubkey) -> Result<usize> {
    let i = seat_index as usize;
    require!(i < NUM_SEATS, OutcryError::BadSeat);
    check_seat(seat, table, i)?;
    require!(
        t.seats[i].kind == SEAT_HUMAN && t.seats[i].owner == *signer,
        OutcryError::NotSeatOwner
    );
    Ok(i)
}

fn trading_open(t: &Table, seat: &Seat) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        t.phase == PHASE_TRADING && now < t.trade_end_ts && seat.round == t.round,
        OutcryError::TradingClosed
    );
    Ok(())
}

fn place_quote(t: &mut Table, seat: &Seat, i: usize, suit: u8, side: u8, price: u8) -> Result<()> {
    let s = suit as usize;
    require!(s < NUM_SUITS, OutcryError::BadSuit);
    require!((MIN_PRICE..=MAX_PRICE).contains(&price), OutcryError::BadPrice);
    match side {
        SIDE_BID => {
            require!(seat.chips >= price as u16, OutcryError::NoChips);
            let own_ask = t.asks[s][i];
            require!(own_ask == 0 || price < own_ask, OutcryError::SelfCross);
            t.bids[s][i] = price;
        }
        SIDE_ASK => {
            require!(seat.hand[s] > 0, OutcryError::NoCard);
            let own_bid = t.bids[s][i];
            require!(own_bid == 0 || price > own_bid, OutcryError::SelfCross);
            t.asks[s][i] = price;
        }
        _ => return err!(OutcryError::BadSide),
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn execute_take(
    t: &mut Table,
    taker: &mut Seat,
    maker: &mut Seat,
    i: usize,
    j: usize,
    suit: u8,
    side: u8,
    slot: u64,
    now: i64,
) -> Result<()> {
    let s = suit as usize;
    require!(s < NUM_SUITS, OutcryError::BadSuit);
    require!(maker.round == t.round, OutcryError::NoQuote);
    let (price, buyer_idx, seller_idx) = match side {
        SIDE_ASK => (t.asks[s][j], i, j),
        SIDE_BID => (t.bids[s][j], j, i),
        _ => return err!(OutcryError::BadSide),
    };
    require!(price != 0, OutcryError::NoQuote);
    {
        let (buyer, seller): (&mut Seat, &mut Seat) = if side == SIDE_ASK {
            (taker, maker)
        } else {
            (maker, taker)
        };
        require!(seller.hand[s] > 0, OutcryError::NoCard);
        require!(buyer.chips >= price as u16, OutcryError::NoChips);
        seller.hand[s] -= 1;
        buyer.hand[s] += 1;
        buyer.chips -= price as u16;
        seller.chips += price as u16;
        if side == SIDE_ASK {
            t.asks[s][j] = 0;
        } else {
            t.bids[s][j] = 0;
        }
        prune(&mut t.bids, &mut t.asks, buyer_idx, &buyer.hand, buyer.chips);
        prune(&mut t.bids, &mut t.asks, seller_idx, &seller.hand, seller.chips);
    }
    let round = t.round;
    t.push_trade(Trade {
        slot,
        unix_ts: now,
        round,
        suit,
        price,
        buyer: buyer_idx as u8,
        seller: seller_idx as u8,
    });
    Ok(())
}

fn pick_two<'a, 'b, T>(v: &'a mut [&'b mut T; NUM_SEATS], i: usize, j: usize) -> (&'a mut T, &'a mut T) {
    assert!(i != j && i < NUM_SEATS && j < NUM_SEATS);
    if i < j {
        let (lo, hi) = v.split_at_mut(j);
        (&mut *lo[i], &mut *hi[0])
    } else {
        let (lo, hi) = v.split_at_mut(i);
        (&mut *hi[0], &mut *lo[j])
    }
}

/// Score, rank, clear the book and reveal every seat.
fn settle(a: &mut Settle) -> Result<()> {
    let table_key = a.table.key();
    {
        let mut t = a.table.load_mut()?;
        let seats = [&a.seat0, &a.seat1, &a.seat2, &a.seat3];
        let mut scores = [0u16; NUM_SEATS];
        let mut filled = [0u8; NUM_SEATS];
        for i in 0..NUM_SEATS {
            check_seat(seats[i], &table_key, i)?;
            if seats[i].round == t.round {
                let (sc, f) = score(seats[i].chips, &seats[i].hand, &seats[i].order());
                scores[i] = sc;
                filled[i] = f as u8;
            }
        }
        t.scores = scores;
        t.filled = filled;
        t.ranks = rank(&scores);
        t.phase = PHASE_SETTLED;
        t.clear_book();
    }
    let seat_infos = [
        a.seat0.to_account_info(),
        a.seat1.to_account_info(),
        a.seat2.to_account_info(),
        a.seat3.to_account_info(),
    ];
    let perm_infos = [
        a.permission0.to_account_info(),
        a.permission1.to_account_info(),
        a.permission2.to_account_info(),
        a.permission3.to_account_info(),
    ];
    let bumps = [a.seat0.bump, a.seat1.bump, a.seat2.bump, a.seat3.bump];
    for i in 0..NUM_SEATS {
        set_seat_permission(
            &seat_infos[i],
            &perm_infos[i],
            &a.permission_program.to_account_info(),
            &a.ephemeral_vault.to_account_info(),
            &a.magic_program.to_account_info(),
            &table_key,
            i as u8,
            bumps[i],
            false,
            None,
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn set_seat_permission<'info>(
    seat: &AccountInfo<'info>,
    permission: &AccountInfo<'info>,
    permission_program: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    magic_program: &AccountInfo<'info>,
    table: &Pubkey,
    index: u8,
    bump: u8,
    private: bool,
    member: Option<Pubkey>,
) -> Result<()> {
    let idx = [index];
    let b = [bump];
    let seeds: &[&[u8]] = &[SEAT_SEED, table.as_ref(), &idx, &b];
    // Flags 0: a member can read the account itself but gets no transaction logs, messages or
    // balances. The deal transaction carries the VRF output (which determines every hand) in its
    // instruction data, so no player may ever be granted transaction visibility.
    let members = member
        .map(|pubkey| vec![Member { flags: 0, pubkey }])
        .unwrap_or_default();
    UpdateEphemeralPermissionCpi {
        payer: seat.clone(),
        permissioned_account: seat.clone(),
        permission: permission.clone(),
        vault: vault.clone(),
        magic_program: magic_program.clone(),
        permission_program: permission_program.clone(),
        authority: seat.clone(),
        authority_is_signer: false,
        args: EphemeralMembersArgs {
            is_private: private,
            members,
        },
    }
    .invoke_signed(&[seeds])?;
    Ok(())
}

// ---------------------------------------------------------------------- contexts

#[derive(Accounts)]
#[instruction(table_id: u64)]
pub struct CreateTable<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        init,
        payer = creator,
        space = Table::SPACE,
        seeds = [TABLE_SEED, creator.key().as_ref(), &table_id.to_le_bytes()],
        bump
    )]
    pub table: AccountLoader<'info, Table>,
    #[account(init, payer = creator, space = 8 + Seat::INIT_SPACE, seeds = [SEAT_SEED, table.key().as_ref(), &[0]], bump)]
    pub seat0: Account<'info, Seat>,
    #[account(init, payer = creator, space = 8 + Seat::INIT_SPACE, seeds = [SEAT_SEED, table.key().as_ref(), &[1]], bump)]
    pub seat1: Account<'info, Seat>,
    #[account(init, payer = creator, space = 8 + Seat::INIT_SPACE, seeds = [SEAT_SEED, table.key().as_ref(), &[2]], bump)]
    pub seat2: Account<'info, Seat>,
    #[account(init, payer = creator, space = 8 + Seat::INIT_SPACE, seeds = [SEAT_SEED, table.key().as_ref(), &[3]], bump)]
    pub seat3: Account<'info, Seat>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(table_id: u64)]
pub struct DelegateTable<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    /// CHECK: the table PDA being delegated
    #[account(mut, del, seeds = [TABLE_SEED, creator.key().as_ref(), &table_id.to_le_bytes()], bump)]
    pub table: UncheckedAccount<'info>,
    /// CHECK: target validator (the TEE validator on devnet)
    pub validator: Option<UncheckedAccount<'info>>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(index: u8, table_id: u64)]
pub struct DelegateSeat<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    /// CHECK: the creator's table PDA (may already be delegated); binds the seat to its creator
    #[account(seeds = [TABLE_SEED, creator.key().as_ref(), &table_id.to_le_bytes()], bump)]
    pub table: UncheckedAccount<'info>,
    /// CHECK: the seat PDA being delegated
    #[account(mut, del, seeds = [SEAT_SEED, table.key().as_ref(), &[index]], bump)]
    pub seat: UncheckedAccount<'info>,
    /// CHECK: target validator
    pub validator: Option<UncheckedAccount<'info>>,
}

#[derive(Accounts)]
pub struct InitRecord<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: any wallet; the record only accumulates stats sent by the program
    pub wallet: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + PlayerRecord::INIT_SPACE,
        seeds = [RECORD_SEED, wallet.key().as_ref()],
        bump
    )]
    pub record: Account<'info, PlayerRecord>,
    pub system_program: Program<'info, System>,
}

#[action]
#[derive(Accounts)]
#[instruction(creator: Pubkey, table_id: u64)]
pub struct RecordRound<'info> {
    /// CHECK: record PDA or placeholder; validated in the handler
    #[account(mut)]
    pub record0: UncheckedAccount<'info>,
    /// CHECK: see record0
    #[account(mut)]
    pub record1: UncheckedAccount<'info>,
    /// CHECK: see record0
    #[account(mut)]
    pub record2: UncheckedAccount<'info>,
    /// CHECK: see record0
    #[account(mut)]
    pub record3: UncheckedAccount<'info>,
    /// CHECK: program that scheduled the action (passed by the delegation program)
    #[account(address = crate::ID @ OutcryError::NotAllowed)]
    pub source_program: UncheckedAccount<'info>,
    /// CHECK: must be this program's table PDA, which only this program can sign for
    #[account(seeds = [TABLE_SEED, creator.as_ref(), &table_id.to_le_bytes()], bump)]
    pub escrow_auth: UncheckedAccount<'info>,
    /// CHECK: only the delegation program can sign for this PDA
    #[account(
        signer @ OutcryError::NotAllowed,
        address = ephemeral_rollups_sdk::pda::ephemeral_balance_pda_from_payer(
            &escrow_auth.key(),
            ACTION_ESCROW_INDEX,
        ) @ OutcryError::NotAllowed,
    )]
    pub escrow: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SeatPermissions<'info> {
    pub signer: Signer<'info>,
    pub table: AccountLoader<'info, Table>,
    #[account(mut)]
    pub seat0: Account<'info, Seat>,
    #[account(mut)]
    pub seat1: Account<'info, Seat>,
    #[account(mut)]
    pub seat2: Account<'info, Seat>,
    #[account(mut)]
    pub seat3: Account<'info, Seat>,
    /// CHECK: permission PDA of seat0
    #[account(mut, seeds = [PERMISSION_SEED, seat0.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission0: UncheckedAccount<'info>,
    /// CHECK: permission PDA of seat1
    #[account(mut, seeds = [PERMISSION_SEED, seat1.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission1: UncheckedAccount<'info>,
    /// CHECK: permission PDA of seat2
    #[account(mut, seeds = [PERMISSION_SEED, seat2.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission2: UncheckedAccount<'info>,
    /// CHECK: permission PDA of seat3
    #[account(mut, seeds = [PERMISSION_SEED, seat3.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission3: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CreatorOnly<'info> {
    pub signer: Signer<'info>,
    #[account(mut)]
    pub table: AccountLoader<'info, Table>,
}

#[derive(Accounts)]
pub struct Join<'info> {
    pub signer: Signer<'info>,
    /// Optional wallet co-signature binding the seat to that wallet's record.
    pub wallet: Option<Signer<'info>>,
    #[account(mut)]
    pub table: AccountLoader<'info, Table>,
}

#[derive(Accounts)]
pub struct Leave<'info> {
    pub signer: Signer<'info>,
    #[account(mut)]
    pub table: AccountLoader<'info, Table>,
}

#[vrf]
#[derive(Accounts)]
pub struct StartRound<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(mut)]
    pub table: AccountLoader<'info, Table>,
    #[account(mut)]
    pub seat0: Account<'info, Seat>,
    #[account(mut)]
    pub seat1: Account<'info, Seat>,
    #[account(mut)]
    pub seat2: Account<'info, Seat>,
    #[account(mut)]
    pub seat3: Account<'info, Seat>,
    /// CHECK: permission PDA of seat0
    #[account(mut, seeds = [PERMISSION_SEED, seat0.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission0: UncheckedAccount<'info>,
    /// CHECK: permission PDA of seat1
    #[account(mut, seeds = [PERMISSION_SEED, seat1.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission1: UncheckedAccount<'info>,
    /// CHECK: permission PDA of seat2
    #[account(mut, seeds = [PERMISSION_SEED, seat2.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission2: UncheckedAccount<'info>,
    /// CHECK: permission PDA of seat3
    #[account(mut, seeds = [PERMISSION_SEED, seat3.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission3: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
    /// CHECK: the delegated VRF queue (ephemeral queue on devnet/mainnet, test queue locally)
    #[account(
        mut,
        constraint = oracle_queue.key() == vrf::consts::DEFAULT_EPHEMERAL_QUEUE
            || oracle_queue.key() == vrf::consts::DEFAULT_EPHEMERAL_TEST_QUEUE
            || oracle_queue.key() == vrf::consts::DEFAULT_QUEUE
            || oracle_queue.key() == vrf::consts::DEFAULT_TEST_QUEUE
    )]
    pub oracle_queue: UncheckedAccount<'info>,
}

/// The VRF callback. `vrf_program_identity` is declared here (the `#[vrf_callback]` macro then
/// leaves it alone) and checked against a compile-time constant: the macro's default constraint
/// evaluates the const fn at runtime, a software SHA-256 PDA search that exhausted the oracle's
/// compute budget on devnet (see NOTES.md, spike Q2).
#[vrf_callback]
#[derive(Accounts)]
pub struct DealCtx<'info> {
    #[account(address = VRF_PROGRAM_IDENTITY)]
    pub vrf_program_identity: Signer<'info>,
    #[account(mut)]
    pub table: AccountLoader<'info, Table>,
    #[account(mut)]
    pub seat0: Account<'info, Seat>,
    #[account(mut)]
    pub seat1: Account<'info, Seat>,
    #[account(mut)]
    pub seat2: Account<'info, Seat>,
    #[account(mut)]
    pub seat3: Account<'info, Seat>,
}

#[derive(Accounts)]
pub struct Act<'info> {
    pub signer: Signer<'info>,
    #[account(mut)]
    pub table: AccountLoader<'info, Table>,
    pub seat: Account<'info, Seat>,
}

#[derive(Accounts)]
pub struct Take<'info> {
    pub signer: Signer<'info>,
    #[account(mut)]
    pub table: AccountLoader<'info, Table>,
    #[account(mut)]
    pub seat: Account<'info, Seat>,
    #[account(mut)]
    pub counter_seat: Account<'info, Seat>,
}

/// Accounts for the bell and the bot tick (the crank runs this with no signer).
#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut)]
    pub table: AccountLoader<'info, Table>,
    #[account(mut)]
    pub seat0: Account<'info, Seat>,
    #[account(mut)]
    pub seat1: Account<'info, Seat>,
    #[account(mut)]
    pub seat2: Account<'info, Seat>,
    #[account(mut)]
    pub seat3: Account<'info, Seat>,
    /// CHECK: permission PDA of seat0
    #[account(mut, seeds = [PERMISSION_SEED, seat0.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission0: UncheckedAccount<'info>,
    /// CHECK: permission PDA of seat1
    #[account(mut, seeds = [PERMISSION_SEED, seat1.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission1: UncheckedAccount<'info>,
    /// CHECK: permission PDA of seat2
    #[account(mut, seeds = [PERMISSION_SEED, seat2.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission2: UncheckedAccount<'info>,
    /// CHECK: permission PDA of seat3
    #[account(mut, seeds = [PERMISSION_SEED, seat3.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission3: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct CloseOut<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub table: AccountLoader<'info, Table>,
    #[account(mut)]
    pub seat0: Account<'info, Seat>,
    #[account(mut)]
    pub seat1: Account<'info, Seat>,
    #[account(mut)]
    pub seat2: Account<'info, Seat>,
    #[account(mut)]
    pub seat3: Account<'info, Seat>,
    /// CHECK: permission PDA of seat0
    #[account(mut, seeds = [PERMISSION_SEED, seat0.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission0: UncheckedAccount<'info>,
    /// CHECK: permission PDA of seat1
    #[account(mut, seeds = [PERMISSION_SEED, seat1.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission1: UncheckedAccount<'info>,
    /// CHECK: permission PDA of seat2
    #[account(mut, seeds = [PERMISSION_SEED, seat2.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission2: UncheckedAccount<'info>,
    /// CHECK: permission PDA of seat3
    #[account(mut, seeds = [PERMISSION_SEED, seat3.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission3: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct PublishRecords<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub table: AccountLoader<'info, Table>,
    /// CHECK: destination program of the action
    #[account(address = crate::ID)]
    pub program_id: UncheckedAccount<'info>,
}

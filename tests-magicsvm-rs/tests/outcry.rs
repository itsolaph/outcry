//! Outcry on MagicSVM: base ledger + ephemeral ledger in one process. Covers the deal,
//! privacy, the book, every rejection path, pruning, the bell, the reveal, the tape ring
//! buffer, the crank-driven 1 human + 3 bots round and the base-layer record action.

use anchor_lang::prelude::Pubkey;
use magicsvm::TransactionTarget::{Base, Ephemeral};
use outcry::game::{self, NUM_SUITS, SIDE_ASK, SIDE_BID, START_CHIPS};
use outcry::state::{PHASE_SETTLED, PHASE_TRADING, TAPE_LEN};
use outcry_magicsvm_tests::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

// OutcryError variant indices (Anchor offsets them by 6000).
const BAD_PRICE: u32 = err_code(3);
const NOT_SEAT_OWNER: u32 = err_code(4);
const TRADING_CLOSED: u32 = err_code(5);
const NO_CARD: u32 = err_code(6);
const NO_CHIPS: u32 = err_code(7);
const SELF_CROSS: u32 = err_code(8);
/// Anchor `ConstraintDuplicateMutableAccount`.
const DUPLICATE_MUTABLE: u32 = 2040;
const NO_QUOTE: u32 = err_code(10);
const ROUND_IN_PROGRESS: u32 = err_code(11);
const SEAT_TAKEN: u32 = err_code(12);
const BELL_TOO_EARLY: u32 = err_code(14);
const NOT_ALLOWED: u32 = err_code(15);
const ALREADY_PUBLISHED: u32 = err_code(17);

fn pk(k: &Keypair) -> Pubkey {
    as_pubkey(&k.pubkey())
}

/// Two humans on seats 0 and 1, bots on 2 and 3, round dealt.
fn two_humans(table_id: u64) -> (Outcry, Keypair, Keypair) {
    let mut o = Outcry::new(table_id);
    let alice = o.player();
    let bob = o.player();
    o.join(&alice, None, 0);
    o.join(&bob, None, 1);
    o.start_and_deal(&alice, false, [table_id as u8; 32]);
    (o, alice, bob)
}

#[test]
fn deal_conserves_the_deck_and_draws_feasible_orders() {
    for seed in [1u8, 2, 3, 99, 200] {
        let mut o = Outcry::new(seed as u64 + 100);
        let p = o.player();
        o.join(&p, None, 2);
        o.start_and_deal(&p, false, [seed; 32]);
        let t = o.table_state();
        assert_eq!(t.phase, PHASE_TRADING);
        assert_eq!(t.round, 1);
        assert_eq!(t.trade_end_ts, START_TS + 90);
        let mut per_suit = [0u8; NUM_SUITS];
        let mut demand = [0u8; NUM_SUITS];
        for i in 0..4 {
            let s = o.seat_raw(i);
            assert_eq!(s.round, 1);
            assert_eq!(s.chips, START_CHIPS);
            assert_eq!(s.hand.iter().sum::<u8>(), 8, "seat {i} holds 8");
            for k in 0..NUM_SUITS {
                per_suit[k] += s.hand[k];
            }
            let order = s.order();
            assert!(order.is_valid(), "{order:?}");
            let r = order.required();
            for k in 0..NUM_SUITS {
                demand[k] += r[k];
            }
        }
        assert_eq!(per_suit, [8; NUM_SUITS], "32 cards, 8 per suit");
        assert!(demand.iter().all(|d| *d <= 8), "orders jointly feasible: {demand:?}");
    }
}

#[test]
fn deal_callback_rejects_a_spoofed_vrf_identity() {
    let (mut o, alice, _bob) = two_humans(7);
    let fake = Keypair::new();
    let spoof = ix(
        outcry::instruction::Deal { randomness: [0; 32], round: 1 },
        outcry::accounts::DealCtx {
            vrf_program_identity: pk(&fake),
            table: o.table,
            seat0: o.seats[0],
            seat1: o.seats[1],
            seat2: o.seats[2],
            seat3: o.seats[3],
        },
    );
    let r = try_send(&mut o.svm, Ephemeral, &[&alice, &fake], &[spoof]);
    assert!(r.is_err(), "spoofed VRF callback must fail");
}

#[test]
fn hands_are_private_to_their_owner_and_flip_public_at_the_bell() {
    let (mut o, alice, bob) = two_humans(8);
    for i in 0..4 {
        let (private, members) = o.permission_private(i);
        assert!(private, "seat {i} private during the round");
        match i {
            0 => assert_eq!(members, vec![pk(&alice)]),
            1 => assert_eq!(members, vec![pk(&bob)]),
            _ => assert!(members.is_empty(), "bot seats have no reader"),
        }
        // Owners read their account but never get transaction visibility (the deal tx carries
        // the VRF output that determines every hand).
        assert!(o.member_flags(i).iter().all(|f| *f == 0), "seat {i} member flags must be 0");
    }
    assert!(o.seat_as(Some(pk(&alice)), 0).is_some(), "owner reads own hand");
    assert!(o.seat_as(Some(pk(&alice)), 1).is_none(), "non-member read denied");
    assert!(o.seat_as(Some(pk(&alice)), 2).is_none(), "bot hand hidden");
    assert!(o.seat_as(Some(pk(&bob)), 0).is_none());
    assert!(o.seat_as(None, 3).is_none(), "anonymous read denied");
    // The public table stays readable.
    o.svm.set_authorized_user(None);
    assert!(o.svm.get_account_for(Ephemeral, &as_address(o.table)).is_some());

    set_time(&mut o.svm, START_TS + 90);
    o.er(&bob, o.ring_bell_ix(), "ring_bell");
    for i in 0..4 {
        assert!(!o.permission_private(i).0, "seat {i} public after the bell");
        assert!(o.seat_as(None, i).is_some(), "revealed seat {i} readable by anyone");
    }
}

#[test]
fn quote_take_and_cancel_happy_paths() {
    let (mut o, alice, bob) = two_humans(9);
    o.poke_seat(0, [3, 2, 2, 1], 200);
    o.poke_seat(1, [1, 3, 2, 2], 200);

    // Replace semantics: one resting ask per seat per suit.
    o.er(&alice, o.quote_ix(&alice, 0, 0, SIDE_ASK, 30), "quote");
    o.er(&alice, o.quote_ix(&alice, 0, 0, SIDE_ASK, 20), "requote");
    assert_eq!(o.table_state().asks[0][0], 20);

    // Bob lifts Alice's ask: 1 spade and 20 chips change hands.
    o.er(&bob, o.take_ix(&bob, 1, 0, SIDE_ASK, 0), "take ask");
    let (a, b, t) = (o.seat_raw(0), o.seat_raw(1), o.table_state());
    assert_eq!((a.hand, a.chips), ([2, 2, 2, 1], 220));
    assert_eq!((b.hand, b.chips), ([2, 3, 2, 2], 180));
    assert_eq!(t.asks[0][0], 0, "filled quote cleared");
    assert_eq!(t.trade_count, 1);
    let tr = t.tape[0];
    assert_eq!((tr.suit, tr.price, tr.buyer, tr.seller, tr.round), (0, 20, 1, 0, 1));

    // Bob bids hearts, Alice hits the bid (sells).
    o.er(&bob, o.quote_ix(&bob, 1, 2, SIDE_BID, 15), "bid");
    o.er(&alice, o.take_ix(&alice, 0, 2, SIDE_BID, 1), "take bid");
    let (a, b, t) = (o.seat_raw(0), o.seat_raw(1), o.table_state());
    assert_eq!((a.hand[2], a.chips), (1, 235));
    assert_eq!((b.hand[2], b.chips), (3, 165));
    assert_eq!(t.bids[2][1], 0);
    assert_eq!(t.trade_count, 2);
    assert_eq!((t.tape[1].buyer, t.tape[1].seller, t.tape[1].price), (1, 0, 15));

    // Cancel.
    o.er(&alice, o.quote_ix(&alice, 0, 3, SIDE_BID, 10), "bid");
    assert_eq!(o.table_state().bids[3][0], 10);
    o.er(&alice, o.cancel_ix(&alice, 0, 3, SIDE_BID), "cancel");
    assert_eq!(o.table_state().bids[3][0], 0);
    // Card and chip conservation between the two traders.
    let (a, b) = (o.seat_raw(0), o.seat_raw(1));
    assert_eq!(a.chips + b.chips, 400);
}

#[test]
fn every_rejection_path() {
    let (mut o, alice, bob) = two_humans(10);
    let mallory = o.player();
    o.poke_seat(0, [0, 3, 3, 2], 200);
    o.poke_seat(1, [2, 2, 2, 2], 5);

    // Selling a card you don't hold: quoting an ask, and hitting a bid.
    let r = o.er_try(&alice, o.quote_ix(&alice, 0, 0, SIDE_ASK, 10));
    expect_custom(r, NO_CARD, "ask without card");
    o.er(&bob, o.quote_ix(&bob, 1, 0, SIDE_BID, 4), "bob bid");
    let r = o.er_try(&alice, o.take_ix(&alice, 0, 0, SIDE_BID, 1));
    expect_custom(r, NO_CARD, "hit bid without card");

    // Buying without chips: quoting a bid, and lifting an ask.
    let r = o.er_try(&bob, o.quote_ix(&bob, 1, 1, SIDE_BID, 6));
    expect_custom(r, NO_CHIPS, "bid without chips");
    o.er(&alice, o.quote_ix(&alice, 0, 1, SIDE_ASK, 20), "alice ask");
    let r = o.er_try(&bob, o.take_ix(&bob, 1, 1, SIDE_ASK, 0));
    expect_custom(r, NO_CHIPS, "lift without chips");

    // Self-cross and self-trade.
    let r = o.er_try(&alice, o.quote_ix(&alice, 0, 1, SIDE_BID, 20));
    expect_custom(r, SELF_CROSS, "bid at own ask");
    let r = o.er_try(&alice, o.quote_ix(&alice, 0, 1, SIDE_BID, 25));
    expect_custom(r, SELF_CROSS, "bid through own ask");
    o.er(&alice, o.quote_ix(&alice, 0, 1, SIDE_BID, 19), "bid under own ask");
    let r = o.er_try(&alice, o.quote_ix(&alice, 0, 1, SIDE_ASK, 19));
    expect_custom(r, SELF_CROSS, "ask down to own bid");
    // Taking your own quote passes your seat twice as a writable account; Anchor rejects the
    // duplicate before the handler's own SelfTrade check can run.
    let r = o.er_try(&alice, o.take_ix(&alice, 0, 1, SIDE_ASK, 0));
    expect_custom(r, DUPLICATE_MUTABLE, "take own quote");

    // No quote / bad price.
    let r = o.er_try(&alice, o.take_ix(&alice, 0, 3, SIDE_ASK, 1));
    expect_custom(r, NO_QUOTE, "take empty level");
    let r = o.er_try(&alice, o.quote_ix(&alice, 0, 1, SIDE_ASK, 0));
    expect_custom(r, BAD_PRICE, "price 0");
    let r = o.er_try(&alice, o.quote_ix(&alice, 0, 1, SIDE_ASK, 100));
    expect_custom(r, BAD_PRICE, "price 100");

    // Wrong seat signer: a stranger, another player, and a bot seat.
    let r = o.er_try(&mallory, o.quote_ix(&mallory, 0, 1, SIDE_ASK, 30));
    expect_custom(r, NOT_SEAT_OWNER, "stranger on seat 0");
    let r = o.er_try(&bob, o.quote_ix(&bob, 0, 1, SIDE_ASK, 30));
    expect_custom(r, NOT_SEAT_OWNER, "bob on alice's seat");
    let r = o.er_try(&mallory, o.take_ix(&mallory, 2, 1, SIDE_ASK, 0));
    expect_custom(r, NOT_SEAT_OWNER, "stranger on bot seat");

    // Seating rules mid-round.
    let r = o.er_try(&mallory, o.join_ix(&mallory, None, 3));
    expect_custom(r, ROUND_IN_PROGRESS, "join mid-round");

    // Bell too early, then trading after the window/bell.
    let r = o.er_try(&mallory, o.ring_bell_ix());
    expect_custom(r, BELL_TOO_EARLY, "early bell");
    set_time(&mut o.svm, START_TS + 90);
    let r = o.er_try(&alice, o.quote_ix(&alice, 0, 2, SIDE_ASK, 30));
    expect_custom(r, TRADING_CLOSED, "quote after window");
    o.er(&mallory, o.ring_bell_ix(), "ring_bell");
    let r = o.er_try(&alice, o.quote_ix(&alice, 0, 2, SIDE_ASK, 30));
    expect_custom(r, TRADING_CLOSED, "quote after bell");
    let r = o.er_try(&bob, o.take_ix(&bob, 1, 1, SIDE_ASK, 0));
    expect_custom(r, TRADING_CLOSED, "take after bell");
    let r = o.er_try(&alice, o.cancel_ix(&alice, 0, 1, SIDE_BID));
    expect_custom(r, TRADING_CLOSED, "cancel after bell");
    // Seat already taken between rounds.
    let r = o.er_try(&mallory, o.join_ix(&mallory, None, 0));
    expect_custom(r, SEAT_TAKEN, "join a human seat");
}

#[test]
fn unbacked_quotes_are_pruned_after_a_trade() {
    let (mut o, alice, bob) = two_humans(11);
    o.poke_seat(0, [1, 4, 2, 1], 200);
    o.poke_seat(1, [2, 2, 2, 2], 120);

    // Alice offers her only spade and also sells it into Bob's bid: her ask is unbacked.
    o.er(&alice, o.quote_ix(&alice, 0, 0, SIDE_ASK, 30), "alice ask spade");
    o.er(&bob, o.quote_ix(&bob, 1, 0, SIDE_BID, 25), "bob bid spade");
    o.er(&alice, o.take_ix(&alice, 0, 0, SIDE_BID, 1), "alice sells spade");
    let t = o.table_state();
    assert_eq!(o.seat_raw(0).hand[0], 0);
    assert_eq!(t.asks[0][0], 0, "alice's spade ask pruned");

    // Bob (95 chips) bids 90 and 50, then pays 40: 55 left, so the 90 bid is pruned.
    o.er(&bob, o.quote_ix(&bob, 1, 3, SIDE_BID, 90), "bob bid 90");
    o.er(&bob, o.quote_ix(&bob, 1, 2, SIDE_BID, 50), "bob bid 50");
    o.er(&alice, o.quote_ix(&alice, 0, 1, SIDE_ASK, 40), "alice ask club");
    o.er(&bob, o.take_ix(&bob, 1, 1, SIDE_ASK, 0), "bob lifts");
    let (b, t) = (o.seat_raw(1), o.table_state());
    assert_eq!(b.chips, 120 - 25 - 40);
    assert_eq!(t.bids[3][1], 0, "unbacked 90 bid pruned");
    assert_eq!(t.bids[2][1], 50, "backed 50 bid kept");
}

#[test]
fn bell_scores_and_ranks_with_seat_tiebreak() {
    let (mut o, alice, _bob) = two_humans(12);
    let mut hands = [[0u8; 4]; 4];
    for i in [0usize, 2] {
        hands[i] = o.seat_raw(i).order().required(); // exactly fills the order
    }
    // seat0 150+100=250, seat1 250 (tie: seat 0 ranks ahead), seat2 100+100=200, seat3 300.
    let chips = [150u16, 250, 100, 300];
    for i in 0..4 {
        o.poke_seat(i, hands[i], chips[i]);
    }
    set_time(&mut o.svm, START_TS + 95);
    o.er(&alice, o.ring_bell_ix(), "ring_bell");
    let t = o.table_state();
    assert_eq!(t.phase, PHASE_SETTLED);
    assert_eq!(t.scores, [250, 250, 200, 300]);
    assert_eq!(t.filled, [1, 0, 1, 0]);
    assert_eq!(t.ranks, [1, 2, 3, 0]);
    assert!(t.bids.iter().chain(t.asks.iter()).all(|row| row.iter().all(|p| *p == 0)), "book cleared");
    // A second bell is rejected.
    let r = o.er_try(&alice, o.ring_bell_ix());
    expect_custom(r, TRADING_CLOSED, "second bell");
}

#[test]
fn tape_ring_buffer_wraps_after_64_trades() {
    let (mut o, alice, bob) = two_humans(13);
    o.poke_seat(0, [8, 0, 0, 0], 300);
    o.poke_seat(1, [0, 0, 0, 0], 300);
    let n = 70u32;
    for k in 0..n {
        let price = (k + 1) as u8;
        // Even k: alice sells to bob. Odd k: bob sells back to alice.
        let (seller, sseat, buyer, bseat) = if k % 2 == 0 { (&alice, 0u8, &bob, 1u8) } else { (&bob, 1u8, &alice, 0u8) };
        let q = o.quote_ix(seller, sseat, 0, SIDE_ASK, price);
        o.er(seller, q, "ask");
        let t = o.take_ix(buyer, bseat, 0, SIDE_ASK, sseat);
        o.er(buyer, t, "lift");
    }
    let t = o.table_state();
    assert_eq!(t.trade_count, n);
    for idx in 0..TAPE_LEN {
        // The newest trade with ring index `idx`.
        let k = if (idx as u32) < n - TAPE_LEN as u32 { idx as u32 + TAPE_LEN as u32 } else { idx as u32 };
        let tr = t.tape[idx];
        assert_eq!(tr.price as u32, k + 1, "slot {idx}");
        assert_eq!(tr.seller, if k % 2 == 0 { 0 } else { 1 });
        assert_eq!(tr.buyer, if k % 2 == 0 { 1 } else { 0 });
    }
    let (a, b) = (o.seat_raw(0), o.seat_raw(1));
    assert_eq!(a.chips + b.chips, 600);
    assert_eq!(a.hand[0] + b.hand[0], 8);
}

#[test]
fn bot_tick_is_rate_limited_and_bots_only_quote_backed_prices() {
    let (mut o, alice, _bob) = two_humans(14);
    let anyone = o.player();
    let before = o.table_state().tick_count;
    o.er(&anyone, o.bot_tick_ix(), "tick 1");
    let after = o.table_state().tick_count;
    assert_eq!(after, before + 1);
    // Same slot: ignored, not an error.
    let tick = o.bot_tick_ix();
    send(&mut o.svm, Ephemeral, &[&alice], &[tick], "tick 2 (same slot)");
    assert_eq!(o.table_state().tick_count, after);
    for _ in 0..12 {
        let s = er_slot(&o.svm);
        o.svm.warp_to_slot(s + outcry::MIN_TICK_SLOTS);
        o.er(&anyone, o.bot_tick_ix(), "tick");
    }
    let t = o.table_state();
    for seat in 2..4 {
        let s = o.seat_raw(seat);
        for suit in 0..NUM_SUITS {
            if t.asks[suit][seat] != 0 {
                assert!(s.hand[suit] > 0, "bot ask is backed");
            }
            assert!(t.bids[suit][seat] as u16 <= s.chips, "bot bid is backed");
            if t.asks[suit][seat] != 0 && t.bids[suit][seat] != 0 {
                assert!(t.bids[suit][seat] < t.asks[suit][seat], "bot never self-crosses");
            }
        }
    }
}

#[test]
fn undelegate_table_returns_table_and_seats_to_base() {
    let (mut o, alice, _bob) = two_humans(16);
    let creator = o.creator.insecure_clone();
    // Not during a round, and only the creator.
    let r = o.er_try(&creator, o.undelegate_table_ix(&creator));
    expect_custom(r, ROUND_IN_PROGRESS, "undelegate mid-round");
    set_time(&mut o.svm, START_TS + 90);
    o.er(&alice, o.ring_bell_ix(), "ring_bell");
    let r = o.er_try(&alice, o.undelegate_table_ix(&alice));
    expect_custom(r, NOT_ALLOWED, "undelegate by a player");

    let delegation_program = as_pubkey(&outcry_magicsvm_tests::DELEGATION_PROGRAM);
    assert_eq!(o.base_owner(&o.table), Some(delegation_program), "delegated before");
    let settled = o.table_state();
    o.er(&creator, o.undelegate_table_ix(&creator), "undelegate_table");
    assert_eq!(o.base_owner(&o.table), Some(program_id()), "table back on base");
    for i in 0..4 {
        assert_eq!(o.base_owner(&o.seats[i]), Some(program_id()), "seat {i} back on base");
        // Closed = drained to 0 lamports (a validator purges it; MagicSVM keeps the stale bytes).
        let perm_lamports = o.svm.ephemeral().get_account(&as_address(o.perms[i])).map_or(0, |a| a.lamports);
        assert_eq!(perm_lamports, 0, "permission {i} closed");
    }
    // The committed base copy carries the final state of the round.
    let acc = o.svm.get_account_for(Base, &as_address(o.table)).unwrap();
    let base: outcry::state::Table = bytemuck_from(&acc.data[8..]);
    assert_eq!((base.round, base.phase), (1, PHASE_SETTLED));
    assert_eq!(base.scores, settled.scores);
    assert_eq!(base.trade_count, settled.trade_count);
}

#[test]
fn full_round_one_human_three_bots_on_the_crank_then_records_and_a_second_round() {
    let mut o = Outcry::new(15);
    let human = o.player();
    let creator = o.creator.insecure_clone();
    // Base-layer lifetime record, created once.
    let init = o.init_record_ix(&creator, &pk(&human));
    send(&mut o.svm, Base, &[&creator], &[init], "init_record");
    o.join(&human, Some(&human), 0);
    o.start_and_deal(&human, true, [42; 32]);
    let order = o.seat_raw(0).order();

    // Let the crank drive the bots for the whole window. The human trades a little too:
    // lift the cheapest bot offer in a suit the order still needs.
    let mut crank_runs = 0usize;
    for sec in 0..100i64 {
        set_time(&mut o.svm, START_TS + sec);
        let slot = er_slot(&o.svm);
        for r in o.svm.warp_to_slot(slot + 20) {
            match r {
                Ok(_) => crank_runs += 1,
                Err(f) => panic!("crank tick failed: {:?}\nlogs: {:#?}", f.err, f.meta.logs),
            }
        }
        if sec % 7 == 3 && sec < 88 {
            let me = o.seat_raw(0);
            let req = order.required();
            let t = o.table_state();
            let mut best: Option<(u8, usize, usize)> = None;
            for suit in 0..NUM_SUITS {
                if me.hand[suit] >= req[suit] {
                    continue;
                }
                for seat in 1..4 {
                    let p = t.asks[suit][seat];
                    if p != 0 && p as u16 <= me.chips && best.map_or(true, |(bp, _, _)| p < bp) {
                        best = Some((p, suit, seat));
                    }
                }
            }
            if let Some((_, suit, seat)) = best {
                let tk = o.take_ix(&human, 0, suit as u8, SIDE_ASK, seat as u8);
                o.er(&human, tk, "human lifts");
            }
        }
    }
    let t = o.table_state();
    assert!(crank_runs > 60, "crank ran {crank_runs} times");
    assert_eq!(t.phase, PHASE_SETTLED, "the crank rang the bell");
    assert!(t.trade_count >= 3, "bots traded: {}", t.trade_count);
    // Conservation and scoring against the revealed seats.
    let mut per_suit = [0u8; NUM_SUITS];
    let mut chips = 0u32;
    let mut scores = [0u16; 4];
    for i in 0..4 {
        let s = o.seat_as(None, i).expect("revealed");
        for k in 0..NUM_SUITS {
            per_suit[k] += s.hand[k];
        }
        chips += s.chips as u32;
        scores[i] = game::score(s.chips, &s.hand, &s.order()).0;
        assert!(!o.permission_private(i).0);
    }
    assert_eq!(per_suit, [8; NUM_SUITS]);
    assert_eq!(chips, 800);
    assert_eq!(t.scores, scores);
    assert_eq!(t.ranks, game::rank(&scores));

    // Records: one standalone Magic Action to the base layer.
    let publish = o.publish_records_ix(&human);
    send(&mut o.svm, Ephemeral, &[&human], &[publish.clone()], "publish_records");
    let rec = o.record(&pk(&human)).expect("record");
    assert_eq!(rec.rounds, 1);
    assert_eq!(rec.best_score, t.scores[0]);
    assert_eq!(rec.wins, (t.ranks[0] == 0) as u32);
    assert_eq!(rec.orders_filled, t.filled[0] as u32);
    assert_eq!(rec.last_round, 1);
    let r = try_send(&mut o.svm, Ephemeral, &[&human], &[publish]);
    expect_custom(r, ALREADY_PUBLISHED, "publish twice");

    // Next round on the same delegated table, crank again: sealed, dealt, played, settled.
    let t0 = START_TS + 200;
    set_time(&mut o.svm, t0);
    o.start_and_deal(&human, true, [43; 32]);
    let t = o.table_state();
    assert_eq!((t.round, t.phase), (2, PHASE_TRADING));
    assert_eq!(t.trade_end_ts, t0 + 90);
    assert_eq!(o.permission_private(0), (true, vec![pk(&human)]));
    assert!(o.seat_as(Some(pk(&human)), 1).is_none(), "bot hand hidden again");
    let trades_before = t.trade_count;
    for sec in 0..100i64 {
        set_time(&mut o.svm, t0 + sec);
        let slot = er_slot(&o.svm);
        for r in o.svm.warp_to_slot(slot + 20) {
            if let Err(f) = r {
                panic!("round 2 crank tick failed: {:?}\nlogs: {:#?}", f.err, f.meta.logs);
            }
        }
    }
    let t = o.table_state();
    assert_eq!(t.phase, PHASE_SETTLED, "round 2 crank rang the bell");
    assert!(t.trade_count > trades_before, "bots traded in round 2");
    assert!(o.seat_as(Some(pk(&human)), 1).is_some(), "round 2 reveal");
    let publish = o.publish_records_ix(&human);
    send(&mut o.svm, Ephemeral, &[&human], &[publish], "publish_records round 2");
    let rec = o.record(&pk(&human)).expect("record");
    assert_eq!((rec.rounds, rec.last_round), (2, 2));
}

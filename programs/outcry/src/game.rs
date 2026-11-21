//! Pure game logic: deal, orders, scoring, quote pruning and the bot policy.
//! Nothing here touches accounts, so it is unit-testable on the host.

pub const NUM_SEATS: usize = 4;
pub const NUM_SUITS: usize = 4;
pub const CARDS_PER_SUIT: u8 = 8;
pub const DECK_SIZE: usize = 32;
pub const HAND_SIZE: usize = 8;
pub const START_CHIPS: u16 = 200;
pub const ORDER_BONUS: u16 = 100;
pub const ORDER_TOTAL: u8 = 6;
pub const MIN_PRICE: u8 = 1;
pub const MAX_PRICE: u8 = 99;

pub const SIDE_BID: u8 = 0;
pub const SIDE_ASK: u8 = 1;

/// A secret order: deliver `qty_a` of `suit_a` and `qty_b` of `suit_b`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct OrderSpec {
    pub suit_a: u8,
    pub qty_a: u8,
    pub suit_b: u8,
    pub qty_b: u8,
}

impl OrderSpec {
    /// Cards of each suit the order requires.
    pub fn required(&self) -> [u8; NUM_SUITS] {
        let mut r = [0u8; NUM_SUITS];
        r[self.suit_a as usize] += self.qty_a;
        r[self.suit_b as usize] += self.qty_b;
        r
    }

    pub fn is_valid(&self) -> bool {
        (self.suit_a as usize) < NUM_SUITS
            && (self.suit_b as usize) < NUM_SUITS
            && self.suit_a != self.suit_b
            && (self.qty_a == 3 || self.qty_a == 4)
            && self.qty_a + self.qty_b == ORDER_TOTAL
    }

    pub fn filled_by(&self, hand: &[u8; NUM_SUITS]) -> bool {
        hand[self.suit_a as usize] >= self.qty_a && hand[self.suit_b as usize] >= self.qty_b
    }
}

/// SplitMix64 stream seeded from 32 bytes of VRF output. The VRF output is the entropy; this
/// only expands it cheaply (no hashing syscalls inside the callback).
pub struct Rng {
    state: u64,
}

impl Rng {
    pub fn new(seed: &[u8; 32]) -> Self {
        let mut state = 0x9E37_79B9_7F4A_7C15u64;
        for chunk in seed.chunks(8) {
            let mut w = [0u8; 8];
            w.copy_from_slice(chunk);
            state ^= u64::from_le_bytes(w);
            state = Self::mix(state);
        }
        Self { state }
    }

    fn mix(mut z: u64) -> u64 {
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        Self::mix(self.state)
    }

    /// Uniform in `0..n` (rejection sampling, unbiased).
    pub fn below(&mut self, n: u64) -> u64 {
        let zone = u64::MAX - (u64::MAX % n);
        loop {
            let v = self.next_u64();
            if v < zone {
                return v % n;
            }
        }
    }
}

/// Result of a deal: four hands (suit counts) and four orders.
#[derive(Clone, Copy, Debug)]
pub struct Deal {
    pub hands: [[u8; NUM_SUITS]; NUM_SEATS],
    pub orders: [OrderSpec; NUM_SEATS],
}

/// Shuffle the 32-card deck, deal 8 to each seat, and draw four orders whose combined demand
/// never exceeds 8 cards of any suit (so all four orders can be filled at the same time).
pub fn deal(seed: &[u8; 32]) -> Deal {
    let mut rng = Rng::new(seed);
    let mut deck = [0u8; DECK_SIZE];
    for (i, card) in deck.iter_mut().enumerate() {
        *card = (i / CARDS_PER_SUIT as usize) as u8;
    }
    for i in (1..DECK_SIZE).rev() {
        let j = rng.below(i as u64 + 1) as usize;
        deck.swap(i, j);
    }
    let mut hands = [[0u8; NUM_SUITS]; NUM_SEATS];
    for (seat, hand) in hands.iter_mut().enumerate() {
        for card in &deck[seat * HAND_SIZE..(seat + 1) * HAND_SIZE] {
            hand[*card as usize] += 1;
        }
    }
    Deal {
        hands,
        orders: draw_orders(&mut rng),
    }
}

fn draw_orders(rng: &mut Rng) -> [OrderSpec; NUM_SEATS] {
    for _ in 0..64 {
        let mut orders = [OrderSpec::default(); NUM_SEATS];
        let mut demand = [0u8; NUM_SUITS];
        for order in orders.iter_mut() {
            let suit_a = rng.below(NUM_SUITS as u64) as u8;
            let suit_b = ((suit_a as u64 + 1 + rng.below(NUM_SUITS as u64 - 1)) % NUM_SUITS as u64) as u8;
            let qty_a = 3 + rng.below(2) as u8;
            *order = OrderSpec {
                suit_a,
                qty_a,
                suit_b,
                qty_b: ORDER_TOTAL - qty_a,
            };
            demand[suit_a as usize] += qty_a;
            demand[suit_b as usize] += ORDER_TOTAL - qty_a;
        }
        if demand.iter().all(|d| *d <= CARDS_PER_SUIT) {
            return orders;
        }
    }
    // Deterministic fallback (practically unreachable): seat s wants 3 of suit s and 3 of s+1,
    // rotated by a random offset so it does not leak a fixed pattern.
    let offset = rng.below(NUM_SUITS as u64) as u8;
    let mut orders = [OrderSpec::default(); NUM_SEATS];
    for (s, order) in orders.iter_mut().enumerate() {
        let a = (s as u8 + offset) % NUM_SUITS as u8;
        *order = OrderSpec {
            suit_a: a,
            qty_a: 3,
            suit_b: (a + 1) % NUM_SUITS as u8,
            qty_b: 3,
        };
    }
    orders
}

/// Final score: chips plus the order bonus when the order is fully held.
pub fn score(chips: u16, hand: &[u8; NUM_SUITS], order: &OrderSpec) -> (u16, bool) {
    let filled = order.filled_by(hand);
    (chips + if filled { ORDER_BONUS } else { 0 }, filled)
}

/// Rank 0 is the winner. Higher score ranks first; ties go to the lower seat index.
pub fn rank(scores: &[u16; NUM_SEATS]) -> [u8; NUM_SEATS] {
    let mut ranks = [0u8; NUM_SEATS];
    for i in 0..NUM_SEATS {
        let mut r = 0u8;
        for j in 0..NUM_SEATS {
            if scores[j] > scores[i] || (scores[j] == scores[i] && j < i) {
                r += 1;
            }
        }
        ranks[i] = r;
    }
    ranks
}

/// Public book: `bids[suit][seat]`, `asks[suit][seat]`, 0 = no quote.
pub type Book = [[u8; NUM_SEATS]; NUM_SUITS];

/// Drop the quotes of `seat` that its private hand no longer backs.
pub fn prune(bids: &mut Book, asks: &mut Book, seat: usize, hand: &[u8; NUM_SUITS], chips: u16) {
    for suit in 0..NUM_SUITS {
        if bids[suit][seat] != 0 && bids[suit][seat] as u16 > chips {
            bids[suit][seat] = 0;
        }
        if asks[suit][seat] != 0 && hand[suit] == 0 {
            asks[suit][seat] = 0;
        }
    }
}

/// What a bot does on its turn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BotAction {
    /// Trade against `counterparty`'s resting quote on `side` of `suit`.
    Take { suit: u8, side: u8, counterparty: u8 },
    /// Replace all own quotes (0 = none).
    Quote {
        bids: [u8; NUM_SUITS],
        asks: [u8; NUM_SUITS],
    },
    Idle,
}

/// Inputs the bot policy may see: its own private state plus the public book. Nothing else.
pub struct BotView<'a> {
    pub seat: u8,
    pub hand: [u8; NUM_SUITS],
    pub chips: u16,
    pub order: OrderSpec,
    pub bids: &'a Book,
    pub asks: &'a Book,
}

/// The most a bot pays for one card of a suit it still needs, given its total shortfall.
fn max_pay(total_need: u8, seat: u8) -> u8 {
    let base: u8 = match total_need {
        0 => 0,
        1 => 60,
        2 => 45,
        3 => 34,
        4 => 27,
        _ => 22,
    };
    base.saturating_sub(seat) // small per-seat personality so bots are not clones
}

/// Legible heuristic:
/// 1. lift the cheapest ask in a suit the order still needs if it is under the bot's limit;
/// 2. hit the best bid in a suit it holds more of than its order needs if the bid is decent;
/// 3. otherwise keep two-sided quotes around a per-suit fair value that leans toward the order:
///    bid up needed suits, offer surplus cheaply, make a loose market in idle suits.
pub fn bot_decide(v: &BotView) -> BotAction {
    let me = v.seat as usize;
    let required = v.order.required();
    let mut need = [0u8; NUM_SUITS];
    let mut surplus = [0u8; NUM_SUITS];
    let mut total_need = 0u8;
    for s in 0..NUM_SUITS {
        need[s] = required[s].saturating_sub(v.hand[s]);
        surplus[s] = v.hand[s].saturating_sub(required[s]);
        total_need += need[s];
    }
    let limit = max_pay(total_need, v.seat);
    let fair = 12u8 + v.seat; // fair value of a card nobody at the table needs yet

    // 1. Lift cheap offers in needed suits.
    let mut best: Option<(u8, u8, u8)> = None; // (price, suit, counterparty)
    for s in 0..NUM_SUITS {
        if need[s] == 0 {
            continue;
        }
        for other in 0..NUM_SEATS {
            let ask = v.asks[s][other];
            if other == me || ask == 0 || ask > limit || ask as u16 > v.chips {
                continue;
            }
            if best.map_or(true, |(p, _, _)| ask < p) {
                best = Some((ask, s as u8, other as u8));
            }
        }
    }
    if let Some((_, suit, counterparty)) = best {
        return BotAction::Take {
            suit,
            side: SIDE_ASK,
            counterparty,
        };
    }

    // 2. Sell surplus into good bids.
    let mut best: Option<(u8, u8, u8)> = None;
    for s in 0..NUM_SUITS {
        if surplus[s] == 0 {
            continue;
        }
        let floor = fair.saturating_sub(2 * surplus[s].min(3)).max(4);
        for other in 0..NUM_SEATS {
            let bid = v.bids[s][other];
            if other == me || bid == 0 || bid < floor {
                continue;
            }
            if best.map_or(true, |(p, _, _)| bid > p) {
                best = Some((bid, s as u8, other as u8));
            }
        }
    }
    if let Some((_, suit, counterparty)) = best {
        return BotAction::Take {
            suit,
            side: SIDE_BID,
            counterparty,
        };
    }

    // 3. Quote.
    let mut bids = [0u8; NUM_SUITS];
    let mut asks = [0u8; NUM_SUITS];
    for s in 0..NUM_SUITS {
        if need[s] > 0 {
            bids[s] = limit.saturating_sub(10).max(fair);
        } else if required[s] == 0 {
            // Idle suit: loose two-sided market around fair value.
            bids[s] = fair.saturating_sub(7).max(MIN_PRICE);
        }
        if surplus[s] > 0 {
            asks[s] = (fair + 6).saturating_sub(2 * surplus[s].min(3)).max(5);
        }
        if bids[s] as u16 > v.chips {
            bids[s] = 0;
        }
        if asks[s] != 0 && bids[s] >= asks[s] {
            bids[s] = asks[s] - 1;
        }
        bids[s] = bids[s].min(MAX_PRICE);
        asks[s] = asks[s].min(MAX_PRICE);
    }
    let same = (0..NUM_SUITS).all(|s| v.bids[s][me] == bids[s] && v.asks[s][me] == asks[s]);
    if same {
        BotAction::Idle
    } else {
        BotAction::Quote { bids, asks }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deal_conserves_cards_and_orders_are_feasible() {
        for k in 0..2000u32 {
            let mut seed = [0u8; 32];
            seed[..4].copy_from_slice(&k.to_le_bytes());
            seed[31] = 0xA5;
            let d = deal(&seed);
            let mut per_suit = [0u8; NUM_SUITS];
            for h in d.hands.iter() {
                assert_eq!(h.iter().sum::<u8>(), 8);
                for s in 0..NUM_SUITS {
                    per_suit[s] += h[s];
                }
            }
            assert_eq!(per_suit, [8; NUM_SUITS]);
            let mut demand = [0u8; NUM_SUITS];
            for o in d.orders.iter() {
                assert!(o.is_valid(), "{o:?}");
                let r = o.required();
                for s in 0..NUM_SUITS {
                    demand[s] += r[s];
                }
            }
            assert!(demand.iter().all(|x| *x <= 8), "{demand:?}");
        }
    }

    #[test]
    fn ranking_breaks_ties_by_seat() {
        assert_eq!(rank(&[200, 300, 300, 100]), [2, 0, 1, 3]);
        assert_eq!(rank(&[250, 250, 250, 250]), [0, 1, 2, 3]);
    }

    #[test]
    fn bot_lifts_cheap_needed_offer() {
        let mut bids = [[0u8; 4]; 4];
        let mut asks = [[0u8; 4]; 4];
        asks[2][1] = 20;
        asks[2][3] = 15;
        bids[0][1] = 3;
        let v = BotView {
            seat: 0,
            hand: [4, 2, 1, 1],
            chips: 200,
            order: OrderSpec { suit_a: 2, qty_a: 4, suit_b: 1, qty_b: 2 },
            bids: &bids,
            asks: &asks,
        };
        assert_eq!(
            bot_decide(&v),
            BotAction::Take { suit: 2, side: SIDE_ASK, counterparty: 3 }
        );
    }

    #[test]
    fn bot_quotes_are_backed_and_uncrossed() {
        let bids = [[0u8; 4]; 4];
        let asks = [[0u8; 4]; 4];
        let v = BotView {
            seat: 2,
            hand: [5, 0, 3, 0],
            chips: 30,
            order: OrderSpec { suit_a: 1, qty_a: 3, suit_b: 3, qty_b: 3 },
            bids: &bids,
            asks: &asks,
        };
        match bot_decide(&v) {
            BotAction::Quote { bids, asks } => {
                for s in 0..4 {
                    assert!(bids[s] as u16 <= 30);
                    if asks[s] != 0 {
                        assert!(v.hand[s] > 0);
                        assert!(bids[s] < asks[s]);
                    }
                }
                assert!(bids[1] > 0 && bids[3] > 0);
                assert!(asks[0] > 0 && asks[2] > 0);
            }
            other => panic!("{other:?}"),
        }
    }
}

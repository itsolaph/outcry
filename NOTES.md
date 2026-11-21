# Outcry — phase 1 notes (on-chain program, tests, devnet)

## 1. Spike against devnet TEE (step 0)

Environment: devnet TEE ER `https://devnet-tee.magicblock.app` (`getVersion`:
`magicblock-core 1.1.1`, git `8886db2`), validator `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`,
Rust SDK `ephemeral-rollups-sdk 0.18.0`, TS SDK `@magicblock-labs/ephemeral-rollups-sdk 0.18.0`,
Anchor 1.1.2. Probe program source: `spike/programs/probe`, script: `spike/scripts/spike.ts`
(raw results: `spike/scripts/spike-results.json`). The probe was deployed as
`91TR6rWBaaXHMmm8dRfyD2B6C61J3XgnvTRW1rtXfCM8` (deploy tx
`4RieUeTe8rnqtUQr2kYxZVLWcTg9Ng6fqciE1qbU27bRuKMSfL23AaqT1knRCnWuoa7Ba33C7MueZQgMWjCrZFvQ`) and
closed afterwards to reclaim its 1.517 SOL of rent.

Setup: three probe PDAs delegated to the TEE validator in one base transaction
(`5JRqkd6BM5ESbMGn26Y1NxwR5AitjuLHAEv8WybfygZrFpxiwdzqDn6vNefANjqBkT7WSQ87nxNxTYYu8SC1FDsq`).
`M` and `O` are fresh keypairs that never held any SOL.

| # | Question | Answer | Evidence (TEE ER signatures unless noted) |
|---|---|---|---|
| 1 | Private ephemeral permission: owner reads with its token, another token cannot | **Yes.** Probe A private with member `M`: `M`'s token reads it; `O`'s token, the deployer's token and no token all get `null`. A member with flags `0` can still read its account. After `UpdateEphemeralPermission(is_private=false)` `O` reads it. | create permission `3eG6jrfqjGCn6foPfeL51xABU2GtLVFPXR87tm4iq7MZWXEX3LmjCKRmQEm8EogX5jYuWS53qXZxWCxDcaSntTdK`; reveal `1pGB6dkbjEfxp2EsXHCYBnHTSCKJNkE6FszC9pzGRh637wLX2fCF74A7gCkph4TKv7N5bmFdDhdzyNeeiBc7fok` |
| 2 | VRF from inside the TEE ER (`DEFAULT_EPHEMERAL_QUEUE`) with a callback into a private account | **Yes, after a fix. The probe's callback failed and was root-caused; in Outcry the callback deals into four private seats within ~0.2 s of `start_round` on every devnet run (section 6). The callback uses 20–35k CU (MagicSVM).** The request was accepted (`5pJnXXYiWtWJdsxWc4FgJUc3mZb1tkmk46WeJnyi2u3smNAs5E97Rpzd3kiJzKBkwBZYARnLSdZaYD8fsRxKjEhL`) and the TEE VRF oracle delivered the callback repeatedly, but every attempt failed with `exceeded CUs meter` after 262,726 CU inside the probe's `CallbackVrf` (e.g. `274erTNezJRpg7tehJSYfziG78jMSduoCDu4dxbXbuG4GqpAN9xg8uzr9Q4f7JDp2aJR7P2SFFmzzZmhXZvKQ5aZ`). Cause: SDK 0.18 `#[vrf_callback]` injects `#[account(address = Pubkey::new_from_array(scoped_vrf_identity_const(&crate::ID).0))]`; in a constraint that const fn runs **at runtime**, i.e. a software SHA-256 PDA bump search, which burns the oracle's whole 300k CU budget. Fix in Outcry: declare `vrf_program_identity` explicitly and check it against a `pub const VRF_PROGRAM_IDENTITY` evaluated at compile time. | see left |
| 3 | A native crank scheduled inside the TEE ER fires repeatedly | **Yes.** `ScheduleTask` 20 × 500 ms: the counter read 9, 11, 14, 16, 19, 20, 20 … over 1 s samples (all 20 iterations ran). A second task whose target has **no signer** called `UpdateEphemeralPermission` on its 3rd tick and the private probe B became readable by a non-member: CPIs signed only by program PDAs work from the crank. | schedule `bji6Pc6Us8dV3P3SqAwgdXCNiGuzNWNLT99bqs2pwsuf2dkCE5UGeb9DtcveBuKSKnXA91KtPFdkTbfPDvuwrnY`; schedule (reveal crank) `5vCnDd3uxvNAT5RKwf7hKr551UrYJe5KcZjwR6VA2FQe7aghSzqCt46KLAv3dnwJN3doh9mG2F4hQ4AE2Dh7nzT` |
| 4 | Does a TEE ER transaction need the signer to hold lamports? | **No.** `M` (0 SOL, never funded) was fee payer and sole signer for the permission creation, the VRF request and both crank schedules; `O` (0 SOL) was fee payer of a write. Guest session keypairs can trade with 0 SOL. | Q1/Q2/Q3 signatures above; `O` write `zcCgGeakXD8zCtGqBEpDHWQAaVxBcG3veXZNvBtxGXLMUS9DAgdeTTK2Jdg8aKQzNGfcHxhKmVd4jfVtRDUXsot` |

Extra findings that shaped the design:

- **A non-member signer can write a private account through the program** (`O` poked `M`'s
  private probe). Permissions gate RPC reads, not program writes, so `take` (taker writes the
  maker's private seat) and the crank (no signer) work.
- **Transactions touching private accounts are redacted.** While A (member `M`) and B (member
  `O`) were private, `getTransaction` of a transaction writing both returned an empty message
  (0 account keys, 0 log lines) to `M`, to `O`, to the sender and to an anonymous caller
  (`3m6vGrbnP5LTQxe3P6GquwL7q9BSZLmK4SJeXmL4jMpPtg3sudF1i9gHxQoVBfsP9S3xwXwN97LQhmH3RgrC33k`);
  same for a flags-0 member (`2GVjWgKkWxNmhUj67MfpPuDEssocZ4jqcyvSSkdMj9znJv6LDZJq5WACqi1qXUC94EiTSXdMoStBjgZGBasVaJYr`).
  Once the accounts were public the VRF fulfillment transactions (randomness in the instruction
  data) were readable by anyone. So the deal transaction must touch the private seats (it does:
  the callback writes all four) and its randomness must not be logged. Outcry makes each seat
  owner a member with **flags 0**: the spike showed a flags-0 member still reads its own
  account, and with no `TX_*` flags no player is ever granted transaction visibility, so the
  deal transaction (whose instruction data determines every hand) stays redacted. The devnet
  script checks this on every run (section 6). The redaction itself is the TEE service's
  behaviour, not something the program enforces.
- `getSignaturesForAddress` on a private account returned nothing to its member; clients should
  not rely on signature scans of private accounts.
- The ephemeral VRF queue `5hBR…` reports "delegated to unknown ER node 1111…" on the router: it
  exists independently on each ER, and the TEE has its own oracle processing it.

Fallbacks recorded: none were needed for Q1, Q3 and Q4. For Q2 the fallback would have been an
off-chain dealer; it is not needed once the callback stays within the oracle's compute budget.
Because cranks work on the TEE, bots run **on-chain** (`bot_tick` on a native crank) and no
server is needed for a judge to play alone.

## 2. Deployment

| | |
|---|---|
| Program id (devnet) | `AUnuoAP1BoujRzy4SSPeiJLoiWKPPsHrAcFqcsiSyWVv` |
| Deploy tx | `LdEAMYcYcQHnopSmvyvKfmLzexpJrigCeMAEdgohq1S5ehRX8vU2Xe1tBm82vTbVhb1kKvqxQ3EHVZYD5UGbhUi` |
| Binary | `target/deploy/outcry.so`, 467 KB, program-data rent 2.375 SOL |
| Keys | `~/.config/solana/outcry-devnet/{deployer,program-keypair,buffer-keypair}.json` (never commit) |
| ER | TEE `https://devnet-tee.magicblock.app`, validator `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` |

The first deployment (`DDUK1YEFPHMvPqPGR1zQ5rxN1q57hDTGi5fh8bxgvfhp`, tx
`36m5rv6fQVCoBf3fpwcgYigF6WGUwsej9hxp7DyrNnCALdgXJ6yGYHJVooSsHV35ChVZ5SCKZBVvsiBPGJQFtaG6`) played a
full devnet round, but `publish_records` failed with `BaseAction: authority pubkey must sign
transaction` (see section 7). The deployer could not fund an upgrade buffer next to the live
program data, so that program was closed (2.375 SOL reclaimed) and the fixed build was deployed
under a fresh id. The closed id can never be reused. The one table created under it
(`8tCW6eHGiRPykTLXFoMkkkYJ7BrjZk2FFPrRiPCUPsQA`, ~0.03 SOL of rent and deposits) can no longer
be undelegated, because its owner program is gone, so those lamports are stranded.

The deployed binary is the repo build: `solana program dump` of the devnet program and
`target/deploy/outcry.so` from a plain `anchor build` both hash to sha256
`50ceff1318a827d970d89b41bb12d110259bcf8e0c8b064abc9f69fccac6ecaf`.

`anchor build` prints a block of `Error: Function … Stack offset of N exceeded max offset of
4096` lines and still exits 0. They name generic instantiations inside dependency crates
(`hybrid_array`, `crypto_common::SerializableState` for large arrays), not Outcry code; the same
lines appear for any program on this SDK/Anchor pin. Outcry's own handlers keep the 64-entry tape
off the stack (zero-copy `Table`).

Deploy command (one-shot; re-running the same command resumes an interrupted buffer upload):

```
anchor build -p outcry
solana program deploy target/deploy/outcry.so \
  --program-id ~/.config/solana/outcry-devnet/program-keypair.json \
  --buffer ~/.config/solana/outcry-devnet/buffer-keypair.json \
  --keypair ~/.config/solana/outcry-devnet/deployer.json --url devnet
```

## 3. Architecture

### Accounts

| Account | Seeds (program `outcry`) | Size | Layer | Rent paid by | Visibility |
|---|---|---|---|---|---|
| `Table` (zero-copy) | `["table", creator, table_id u64 LE]` | 1,976 B | created on base, delegated to the TEE once, lives on the ER | table creator | public |
| `Seat` ×4 (Borsh) | `["seat", table, [index]]` | 56 B | created on base with the table, delegated once | table creator (+6,208 lamports prefund each for its ephemeral permission) | private to its owner during a round; public after the bell |
| `EphemeralPermission` ×4 | permission program PDA of the seat | 2-member capacity | ER only (`CreateEphemeralPermissionCpi`) | the seat PDA itself (from the prefund) | n/a |
| `PlayerRecord` | `["record", wallet]` | 99 B | base, never delegated | whoever calls `init_record` (one-time) | public |

`Table` holds: creator, id, phase (`lobby → dealing → trading → settled`, then back to
`dealing` on the next `start_round`), round counter, `window_secs` (15..=600, default 90,
changeable between rounds by the creator), `trade_end_ts`, the roster (`owner` session key,
optional `wallet`, kind human/bot), the book as `bids[suit][seat]` / `asks[suit][seat]` (price
1..=99, 0 = none, so at most one bid and one ask per seat per suit), bell results (`scores`,
`ranks`, `filled`), crank bookkeeping, and the 64-entry tape ring (`slot`, `unix_ts`, `round`,
`suit`, `price`, `buyer`, `seller`; index = `trade_count % 64`).
`Seat` holds `hand[4]` (counts per suit), `chips`, and the secret order
(`suit_a, qty_a, suit_b, qty_b`).

### Instructions and routing

| Instruction | Layer | Signer | Notes |
|---|---|---|---|
| `create_table(table_id, window_secs)` | base | creator | creates table + 4 seats |
| `delegate_table`, `delegate_seat(i)` | base | creator | to the TEE validator, once per table |
| `init_record` | base | anyone | creates a wallet's `PlayerRecord` |
| `init_permissions` | ER | anyone | creates the 4 seat permissions (idempotent) |
| `join(seat, [wallet co-signer])` / `leave` | ER | session key | between rounds; a wallet co-signature binds the seat to that wallet's record |
| `set_window` | ER | creator | between rounds |
| `start_round(use_crank)` | ER | seated human or creator | clears seats, seals each permission (private; the human owner is the only member, with flags 0; bot seats have no member), requests VRF from the ephemeral queue, optionally schedules the crank. If no deal arrives within 20 s it may be called again to re-request VRF (same round) |
| `deal` (VRF callback) | ER | VRF program identity (compile-time constant) | shuffles the 32 cards, deals 8 per seat, draws 4 orders, sets 200 chips, opens a `window_secs` window. A stale or duplicate callback is a no-op |
| `quote(seat, suit, side, price)` / `cancel` | ER | seat owner | replace semantics; validates backing and self-cross |
| `take(seat, suit, side, counterparty)` | ER | seat owner | 1 card for `price` chips between the two private seats, clears the filled quote, prunes both parties' unbacked quotes, appends to the tape |
| `ring_bell` | ER | anyone | after the window: score = chips + 100 if the order is fully held, rank (ties by seat index), clear book, flip all 4 permissions public |
| `bot_tick` | ER | none (crank) / anyone | ≤1 bot action per tick (round-robin over bot seats), rate-limited to one per 8 slots; rings the bell when the window is over |
| `publish_records` | ER | anyone (pays nothing) | once per settled round: schedules a standalone Magic Action `record_round` on base |
| `record_round` | base | Magic Action only (escrow signer + table PDA as escrow authority) | idempotent per (table, round) |
| `undelegate_table` | ER | creator | between rounds: closes permissions, `commit_and_undelegate` table + seats |

Deal and orders (`game.rs`): the 32-byte VRF output seeds a SplitMix64 stream (cheap, no
hashing syscalls inside the oracle's compute budget). Fisher–Yates shuffles the deck and seats
take 8 cards each. Orders are drawn by rejection sampling until the four orders' combined demand
is ≤ 8 for every suit (fallback after 64 tries: a rotated deterministic pattern). So every order
is feasible, and all four can be filled simultaneously. Nothing about the orders is public until
the bell.

Bots (`game.rs::bot_decide`, run by `bot_tick`) see only their own seat and the public book:
1. Lift the cheapest ask in a suit their order still needs, if it is under a limit that rises as
   the shortfall shrinks (60 for the last card, 22 when 5+ short).
2. Otherwise hit the best bid for a surplus suit, if it is above a floor around fair value.
3. Otherwise keep two-sided quotes: bid up needed suits, offer surplus cheaply, and make a loose
   market in suits the order does not use.

Small per-seat offsets keep the bots from being clones. Bot quotes are always backed and never
self-cross (tested).

### Why the record goes through a standalone Magic Action

`publish_records` schedules `add_standalone_actions([record_round])` with the table PDA as the
escrow authority (`build_and_invoke_signed`) and the caller as the intent payer. Reasons:

- **No commit, so no commit nonce.** The table and seats are never committed during play, so the
  10-commit cap of the no-fee-vault path and the 1,000,000-lamport-per-commit charge at
  undelegation never apply. Tables stay delegated round after round. The two alternatives both
  spend a commit per round:
  - committing the table with a post-commit action would hit `0xA0000000` at round 11;
  - delegating each `PlayerRecord` and committing it would add a ~3.2M-lamport deposit per player
    and hit the same cap.
- **Free per round.** The validator pays the base transaction fee of the action. The payer is
  not delegated, so the fee-vault path (and its Base Action fee) is not used. `record_round`
  allocates nothing, so the escrow needs no balance. The devnet round shows the human's 0-SOL key
  as the intent payer.
- **Authenticated.** `record_round` requires the delegation program's escrow PDA as signer, and
  `escrow_auth` must be this table's PDA, which only this program can sign for. It is idempotent
  via `(last_table, last_round)`.

### Cost per table and per round (devnet, measured)

| Item | Lamports | When |
|---|---:|---|
| Table rent (1,976 B) | 10,688,320 | once per table (stays locked while delegated) |
| 4 × seat rent + permission prefund | 4 × 940,928 = 3,763,712 | once per table |
| Delegation deposits, table (record 1,559,040 + metadata 1,656,480) | 3,215,520 | once per table |
| Delegation deposits, 4 seats (1,559,040 + 1,600,800 each) | 12,639,360 | once per table |
| `PlayerRecord` rent (99 B) | 1,153,160 | once per wallet |
| 4 base transaction fees | 20,000 | setup |
| **Total measured on devnet** (`deployer spent` in section 6) | **31,480,072** | one table + one record |
| ER transactions (join, start, VRF request, quotes, takes, bell, ticks, publish) | 0 | every round; 0-SOL signers work |
| Record Magic Action | 0 to the app | every round (validator pays the base fee) |

Per round, the marginal cost is **0 lamports** for the table creator and the players. On
retirement, `undelegate_table` does one commit-and-undelegate (`last_commit_id` 1, so the fee is
the 3,000,000-lamport session fee per account). That forfeits 15.0M of the 15.85M in deposits.
**Measured** on devnet (extended run, section 6): undelegation refunded **854,880 lamports**
(215,520 for the table + 4 × 159,840 for the seats), exactly the formula's value. The deployer's
net spend for that table was 30,625,192 vs 31,480,072 for a table left delegated. The table and
seat account rent (14.45M) stays in those accounts, which are owned by the program on base again.
`scripts/inspect-costs.ts <table>` prints the locked amounts for any table.

## 4. Tests

```
anchor build -p outcry                                   # tests load target/deploy/outcry.so
cargo test --manifest-path tests-magicsvm-rs/Cargo.toml  # MagicSVM: base + ER ledgers in process
cargo test -p outcry --lib                               # host unit tests of game.rs
```

MagicSVM suite (11 tests, all green), `tests-magicsvm-rs/tests/outcry.rs`:

| Test | Covers |
|---|---|
| `deal_conserves_the_deck_and_draws_feasible_orders` | 5 VRF seeds: 32 cards conserved, 8 per seat and per suit, 200 chips, valid orders, joint demand ≤ 8 per suit, window = 90 s |
| `deal_callback_rejects_a_spoofed_vrf_identity` | the callback only accepts the VRF program identity |
| `hands_are_private_to_their_owner_and_flip_public_at_the_bell` | permissions private with the owner as sole wallet member (flags 0), bots have none; owner reads, other player / anonymous reads denied; the table stays public; after the bell all permissions are public and readable by anyone |
| `quote_take_and_cancel_happy_paths` | replace semantics, lifting an ask, hitting a bid, cancel, tape entries, chip conservation |
| `every_rejection_path` | selling without the card (quote and take), buying without chips (quote and take), self-cross both ways, taking your own quote, empty level, price 0/100, wrong signer (stranger, other player, bot seat), join mid-round, early bell, quote/take/cancel after the window and after the bell, joining a human seat |
| `unbacked_quotes_are_pruned_after_a_trade` | seller's ask with no card left and buyer's bid above remaining chips are pruned; backed quotes kept |
| `bell_scores_and_ranks_with_seat_tiebreak` | chips + 100 only when fully held, tie broken by seat, book cleared, second bell rejected |
| `tape_ring_buffer_wraps_after_64_trades` | 70 trades: ring holds trades 7..70 at index `k % 64` |
| `bot_tick_is_rate_limited_and_bots_only_quote_backed_prices` | same-slot tick ignored; bot quotes backed and uncrossed |
| `full_round_one_human_three_bots_on_the_crank_then_records_and_a_second_round` | crank drives 3 bots and rings the bell; human trades; conservation; scores and ranks match the revealed seats; `publish_records` writes the base record once (second call rejected); round 2 on the same delegated table, again on the crank: re-sealed, dealt, bots trade, crank bell, reveal, record reaches `rounds == 2` |
| `undelegate_table_returns_table_and_seats_to_base` | rejected mid-round and for a non-creator; after the bell the creator's `undelegate_table` closes the 4 permissions and returns table + seats to the program on base, carrying the final round state |

Taking your own quote is rejected by Anchor's duplicate-mutable-account check (2040) before the
handler's own `SelfTrade` check runs; the test asserts 2040.

## 5. Devnet script

```
npx tsx scripts/devnet-round.ts [window_secs] [extended]   # default 90
```

With `extended`, after round 1 the script also:
- plays round 2 on the same delegated table with the crank, re-checking privacy and the reveal;
- publishes again and expects `rounds == 2`;
- calls `undelegate_table` and waits until the table and seats are owned by the program on base.

Creates a fresh table (deployer pays base setup), initializes a `PlayerRecord` for a fresh
never-funded human keypair, then has the human join seat 0 bound to its wallet and start the
round with the crank. While the crank-driven bots trade, the human chases its order. The script:
- proves the human's token cannot read a bot seat and an anonymous token cannot read the human's
  seat;
- scans the table's transactions with both tokens to show the deal transaction is not readable;
- waits for the crank's bell (manual `bot_tick` / `ring_bell` fallbacks exist but were never
  needed);
- proves the bot seat is readable after the bell and prints the tape and the scoreboard;
- publishes records and waits for the base `PlayerRecord` to change.

Other scripts: `scripts/check-client.ts` (offline: builds every instruction),
`scripts/inspect-costs.ts` (base lamports locked by a table), `spike/scripts/spike.ts` (step 0).

## 6. Devnet round output (real run, 90 s window, program `AUnuoAP1…`)

Since this run, the script changed in two ways. Its late-VRF retry branch, which did not
trigger here, now passes `use_crank = false`, and the `extended` mode was added. The extended run
below exercises the final script.

```
[   0.1s] program AUnuoAP1BoujRzy4SSPeiJLoiWKPPsHrAcFqcsiSyWVv
[   0.4s] creator/deployer FLsPR5utXsdbTioYKny9BXwmuFfFThLwPpLuSPDRwWaY 0.538875616 SOL
[   0.4s] human (0 SOL) CTCFafi3bU1tZQKiLXv5Y8P8M2ozmLJpiidfDfKYjNqk balance 0
[   8.0s] table H1XjVzo11KLj4r8zZHC5nW2YNyWG2ZKn8CeWNZkWZ4Do id 1795239920365
[   8.0s] tx create_table (base) 3LDS1x8DKcQ8EJ4pzftLDpZpuwf4XY4ZwqLsmgb3ssKKwPLMFFxWtxBjkFBC9E2B7GYEh57XyjWUuU6XFE75okC8
[   8.0s] tx delegate table+seat0 (base) YRnGpuD77cdiNZGGzeiAKM2WiAAJ5mzfaCYaMT7KHgXkPHSeoVKSgPBUYabeVxtwyjEUJBbtvuKodnb2frPsATF
[   8.0s] tx delegate seats 1-3 (base) 59PxyBtvnRhWRfA9oFPrm3kPh9V4ceJEfkBh5RPTCXkTjuVAdXyhqXFPe151JNJGY8ybzb3n6hd9L5bYsWrdDAjy
[   8.0s] tx init_permissions (ER) 5raFBZWn3bPzCdzNGin7VJnDiUoMy7tvxqFpDZMpAhQEYFbbNDYtjXybB1hmBQP7imXTSawJoMgrrQFjbpP2MS4m
[   8.8s] tx init_record for the human's wallet (base) 2L5ToxpMfHsaUkpmZfEZDjBRLaZsXJRi6X7zUPymjsmxG2Ke4WZPMAxe2sBixCa44dvj37ZcsBQv6NLbkrAi9BBd
[  11.1s] tx join seat 0 (ER, 0-SOL signer) 2hrCRWsBRaPgzc4SCsXY9oWBGxK4arN3BBGnDC45CkvcHiVkqkLiXiPV43DDoAmJiXnKYgtfWKYN8dckxrBV7HJw
[  12.1s] tx start_round + VRF request + crank schedule (ER) 3Z681g488eztFh6QsBbRvE1a9fxPWw2pRk5QVNKVjJwg7tkVDvroswQwJGQkdSQGqzCgdQ6YoPus4Z4WkQxJ4k8x
[  12.3s] VRF callback dealt round 1 after 0.0s; trading ends at unix 1795240021
[  12.6s] human seat 0 (own token): hand S2 C1 H2 D3 chips 200 order 4xclubs + 2xdiamonds
[  12.8s] PRIVACY during round: human token reading bot seat 1 -> DENIED (account hidden (null))
[  13.0s] PRIVACY during round: no-token read of seat 0 -> DENIED
[  14.1s] PRIVACY during round: human token lists 3 table txs, 2 with readable message/logs, deal tx redacted/absent
[  14.8s] PRIVACY during round: no token lists 2 table txs, 2 with readable message/logs, deal tx redacted/absent
[  18.8s] tx take: human buys 1 clubs @17 from seat 3 56XobJRmdCAzWVGudrBjpZeBjyATgLoREkL35hA8MLoSBP7RZyzEw2eAwPrChc7DuSTmykQn3pE9QepWWx5Mu3f2
[  22.8s] tx take: human buys 1 clubs @19 from seat 3 2zaUzeqCL8YKhYi3kJsDTH3fR9CEr7rBLjkzPqcb5R7RMmGGys7JcDhGXu7ZMf94kqLRfWSwyBmD9t3gWkRmvZFP
[  26.2s] human action rejected (book moved): Simulation failed. 
[  29.7s] human action rejected (book moved): Simulation failed. 
[  33.8s] tx take: human sells 1 spades @32 to seat 3 3WBmQTHHZZg3G9pN2F1JZi22i77qjjqtzKVKRSWH5YYyiEKeMAWhaghEeWQo1hnrTwEFjbwotrTmRFdvsweQvmxJ
[  37.8s] tx take: human buys 1 clubs @16 from seat 2 4z36rzffaiwAxkDGg9HypTU5B82vRtYkNbp7uH2ZeqfzJeo6vXQU5QZQ2NFFJH2kQcxRw4wE3Da2hKTzAZLpHuXS
[  42.1s] tx take: human sells 1 hearts @8 to seat 3 12Cdi4fTPzQ6KjFMHESxe8KuUjLfAwzC9fbW35713u4hp8htTJHBbnUV8LjK8iTmcB1k3nsk9NCjE1HkRB1Khg1
[  46.2s] tx take: human sells 1 hearts @8 to seat 3 5LHuYnMK1bc8Uyh3DubDRkqzrxCRpsHm9Wew2Da4WXEzg9jXGsudbWxCBYXHqadQZpG6t8PC7k71Q1CMcJadY9Lb
[ 102.5s] bell rung: phase settled, ticks 90 (manual fallbacks: 0), trades 12
[ 104.2s] PRIVACY after bell: human token reading bot seat 1 -> VISIBLE (revealed)

TAPE (oldest first)
  05:45:33  hearts   @15  seat1 -> seat2
  05:45:37  diamonds @15  seat1 -> seat2
  05:45:38  clubs    @17  seat3 -> seat0
  05:45:41  hearts   @17  seat1 -> seat2
  05:45:42  clubs    @19  seat3 -> seat0
  05:45:45  spades   @34  seat2 -> seat1
  05:45:49  spades   @49  seat2 -> seat1
  05:45:53  spades   @32  seat0 -> seat3
  05:45:54  spades   @18  seat2 -> seat3
  05:45:57  clubs    @16  seat2 -> seat0
  05:46:01  hearts   @ 8  seat0 -> seat3
  05:46:05  hearts   @ 8  seat0 -> seat3

FINAL SCOREBOARD (round 1)
  #1  seat 2 bot           score 370 = 270 chips + 100  hand S0 C1 H4 D2  order 4xhearts + 2xdiamonds FILLED
  #2  seat 0 human CTCFaf  score 296 = 196 chips + 100  hand S1 C4 H0 D3  order 4xclubs + 2xdiamonds FILLED
  #3  seat 3 bot           score 270 = 170 chips + 100  hand S4 C0 H4 D2  order 4xspades + 2xdiamonds FILLED
  #4  seat 1 bot           score 264 = 164 chips + 100  hand S3 C3 H0 D1  order 3xspades + 3xclubs FILLED

[ 105.5s] tx publish_records (ER, schedules base-layer Magic Action) 566gRD6iCmecvBMw1kxXc6KRBQ7wB6nbcFvvFzubTPE2otD4xQSTiKABdio9dizQe6QiUxEYJ41BPJbYdGe5fCeD
[ 107.1s] base PlayerRecord updated: rounds 1, wins 0, orders filled 1, best 296, last round 1
[ 107.9s]   base tx touching the record: 5mZU8y9FNdQzPmH5DVoWhij17kDthTgkS2jMJJN3EVWQ9zmeg8w3E1JEdByQxv7FLz3im35DXzKCYYFytHrJGd7J
[ 107.9s]   base tx touching the record: 2L5ToxpMfHsaUkpmZfEZDjBRLaZsXJRi6X7zUPymjsmxG2Ke4WZPMAxe2sBixCa44dvj37ZcsBQv6NLbkrAi9BBd
[ 108.3s] deployer spent 31480072 lamports on base (one-time table setup + record init); human balance 0
[ 108.3s] human signed 6 trading transactions; done.
```

Reading it:
- The window is 90 s from the deal (12.3 s → 102.5 s); the crank ticked 90 times and rang the
  bell itself.
- The two "book moved" rejections are the human racing a bot for the same quote; preflight
  rejects them and nothing changes.
- `5mZU8y…` is the base transaction that executed the Magic Action.
- The script did not identify the 2 readable table transactions. It only checks that none of
  the listed transactions is the deal (no `Deal` log, no VRF program key). The spike suggests
  they are ones that write no private seat.
- A shorter debug run on the same program (20 s window, table
  `13CtoxNGBp4mRNMLQox1TB79HUvd9gzS5SM49ofLCr9o`) gave the same results.

### Extended run: two rounds on one table, then undelegation (20 s window)

This run used the final script on disk (`scripts/devnet-round.ts 20 extended`). Round 1 prints
the same sections as above; they are abridged here, and every other line is verbatim.

```
[   0.1s] program AUnuoAP1BoujRzy4SSPeiJLoiWKPPsHrAcFqcsiSyWVv
[   0.2s] creator/deployer FLsPR5utXsdbTioYKny9BXwmuFfFThLwPpLuSPDRwWaY 0.507395544 SOL
[   0.2s] human (0 SOL) LBfF4D145miZbEnjsJncYh6EvnopFghT7ngmVMGz1yn balance 0
[   7.5s] table HBbHGrcmMcfnNS9ptJi4SvZLpKmR2siHLJnX4tBXmktm id 1795240680253
[   7.5s] tx create_table (base) 5bRVSsiaHGGAd7q5bKMdaq1EyxMiemSrekDCfFFTrmv2oksjqxytes7KKpHUQY7t22fhEiW9sp4Gnhh7KigjL1N7
[   7.5s] tx delegate table+seat0 (base) 3wCTq1pfys4WPHCWEdVChdhP3q38wRppMby6weKuHeA2EMpPkhudSh7NaHw2cQ3BGiUic5Fq4HP3pse9L7nCvEzk
[   7.5s] tx delegate seats 1-3 (base) 34au4ueeBsC1nHrM382A4ceo2gDGu3cu1NdayYsWvhfn2VphkoK8Ve7QCxGs2HrGKGcmeRWokztkQNe3dsEWRn7d
[   7.5s] tx init_permissions (ER) 9eL84ZKTpmY5DnK7gCKJnyRf7DxLGzdzyrDEM7wwprtxGqCVRaKVNWE3hwzU2p2nhGkQhb9pwg8mSAD1eZvyc8u
[   8.3s] tx init_record for the human's wallet (base) 4oEbBU7TuMgQNNg8VePLenn6HjUoo6WQ8Fdy8j9qvEcfLLAjtYMJt4o8kN6AYkhaKKtN8YZaDkgVkD7hWRVkrCco
[  10.7s] tx join seat 0 (ER, 0-SOL signer) 32tyM6wh7W3aT19s4foAMMEFJUZLc5r3DiFiqMCrScQ6JAeuXnt4K6eS7pmeumBLuDbVBecY5SdVyhToS4prBvQT
[  11.7s] tx start_round + VRF request + crank schedule (ER) dSpXGJbMVyHBXrF1FgRnTt5WHZrEN6TGrhFGLrVCfWNaKgFPVDqBUntoTFQtfRdAN4y8MUrdfp5xsaDBob9WYuX
[  12.0s] VRF callback dealt round 1 after 0.0s; trading ends at unix 1795240711
[  12.5s] PRIVACY during round: human token reading bot seat 1 -> DENIED (account hidden (null))
[  12.7s] PRIVACY during round: no-token read of seat 0 -> DENIED
[  13.8s] PRIVACY during round: human token lists 3 table txs, 2 with readable message/logs, deal tx redacted/absent
[  14.5s] PRIVACY during round: no token lists 2 table txs, 2 with readable message/logs, deal tx redacted/absent
  ... (3 human takes)
[  32.0s] bell rung: phase settled, ticks 20 (manual fallbacks: 0), trades 6
[  33.7s] PRIVACY after bell: human token reading bot seat 1 -> VISIBLE (revealed)
  ... (tape, scoreboard: human #3 with 319 = 219 chips + 100, order filled)
[  35.0s] tx publish_records (ER, schedules base-layer Magic Action) 64EyPLDn2oVHVrnDLEYMJqJGtb98tnBqWPtwJEb7pJvKDrRWTxy4de4MAsknEXC5snfBnPyfoudmSsNGTbcuHhB2
[  36.5s] base PlayerRecord updated: rounds 1, wins 0, orders filled 1, best 319, last round 1
[  37.3s]   base tx touching the record: 5xjxBBMSXQvQbhaSG2jmmaVtPkecj6X42vg3Z8L4dFrrm4WVTUZQFp6HNi34DFNZgpZ3oWC2w5QJJ2155a2Z8UQ8
[  38.3s] ROUND 2: tx start_round + VRF + crank (same table, no re-delegation) 5u4M6oTUYZZZHru7VEaYFATiCcHe4pszC6k8NNyLgkkr3cfetrUvBa7PSf4Q5DQN6Ggh6c9mXRAj4DYSxyL2xbhm
[  39.5s] ROUND 2: dealt round 2; trading ends at unix 1795240737
[  39.8s] ROUND 2 PRIVACY: human token reading bot seat 1 -> DENIED
[  57.7s] ROUND 2: bell rung by the crank, ticks 58, 8 bot trades, scores 200/200/360/240, ranks 2/3/0/1
[  59.5s] ROUND 2 PRIVACY after bell: bot seat 1 -> VISIBLE (revealed)
[  60.5s] ROUND 2: tx publish_records 5eairqXckRejRoHkRzaKPEtz73tjxbhzBjDuuHzCXiHkn6zqZyxLsNkGpaTN6C7Ki6WWRCocCAqbSPH8dzWeikq6
[  63.6s] ROUND 2: base PlayerRecord rounds 2, wins 0, filled 1, best 319, last round 2
[  65.4s] tx undelegate_table (ER, creator) 4ZdHLB4ooV3va3L7YtPX7NmcUfZXR34Dn12Vhwqq1vBqYhZwNxqbD8J39sciNhEpJoShkLMM5YGkyThMwJMD2Y9w
[  65.4s] UNDELEGATED after 0.1s: table + 4 seats owned by the program on base; base table round 2, phase settled, trades 15
[  65.7s] deployer spent 30625192 lamports on base (one-time table setup + record init); human balance 0
[  65.7s] human signed 3 trading transactions; done.
```

Reading it:
- `ticks` and `trades` are lifetime counters on the table, not per round.
- "8 bot trades" counts from the first read after the round-2 deal. One bot trade landed in the
  second before that read: 6 + 9 = 15 in total.
- In round 2 the scripted human only waits, so it finishes on its 200 starting chips.

## 7. Findings from testing

- **Magic Action escrow authority must sign (MagicSVM vs TEE difference).** The TEE's magic program rejects a scheduled
  action unless its escrow authority is a signer of the scheduling CPI. SDK 0.18's
  `MagicIntentBundleBuilder::build` copies `is_signer` from each `AccountInfo` and forces it only
  for the payer. A PDA escrow authority that is not also the payer therefore goes in unsigned,
  even under `build_and_invoke_signed`. MagicSVM does not check this, so the suite was green while
  devnet failed. Fix: pass a clone of the table `AccountInfo` with `is_signer = true`; the seeds
  given to `build_and_invoke_signed` authorize it.
- **Permission members include the owner program (observed in MagicSVM only).** In MagicSVM the
  permission program lists the permissioned account's owner program as a member next to the
  wallets passed in. This was not checked on the TEE. The tests ignore it: a program cannot
  obtain a TEE auth token.
- **Closed permissions in MagicSVM** keep their bytes at 0 lamports after
  `CloseEphemeralPermission`; a validator purges 0-lamport accounts. The undelegation test asserts
  0 lamports.

## 8. Known limits

- **Records are at-most-once.** `publish_records` advances `records_round` when it schedules the
  action. If the base action then failed, that round's result would be lost for the record; there
  is no retry or reconciliation. Clients can compare `PlayerRecord.last_round` to the table round.
- **Wallets without a record are skipped.** A wallet whose `PlayerRecord` was never initialized,
  and seats joined without a wallet co-signature, are skipped silently. The web client should call
  `init_record` (base, needs SOL from the wallet or a sponsor) once per wallet.
- **Binding a session key to a wallet** requires the wallet to co-sign `join` once. There is no
  session-key program; the session keypair is the seat owner for the round.
- **No commits during play.** The table and seats are never committed while in use, so the base
  copy is stale (creation-time state) until `undelegate_table`. If the ER lost state, the
  in-progress round would be lost; lifetime stats already published are safe on base.
- **Bot fairness is enforced by program code.** Bots only read their own seat and the book, but
  this is a property of `bot_decide`'s inputs, not of the TEE (the program can read all seats).
- **Bot activity is bounded by the crank.** The crank runs `window_secs + 45` ticks at 1 s; each
  tick moves at most one bot. If the VRF callback were delayed past 45 s, the crank would end
  early. `bot_tick` and `ring_bell` are permissionless, so a client can drive both by hand.
- **`start_round` retry:** after 20 s in `dealing`, anyone seated can call `start_round` again to
  re-request VRF. Pass `use_crank = false` on that retry: crank task ids are derived from
  (table, round), and the first crank is still scheduled.
- **Transaction redaction is the TEE's behaviour.** Some table transactions are readable. In the
  spike, transactions writing a private account came back redacted for every caller, and on
  devnet the deal transaction was never readable. Outcry keeps
  member flags at 0 so that no player can ever be granted transaction visibility.
- **Devnet budget.** The deployer holds ~0.477 SOL after these runs. A new table costs
  ~0.0315 SOL (~0.0306 SOL net if later undelegated). Upgrading the 467 KB program needs a
  ~2.4 SOL buffer, which the deployer cannot fund (the devnet faucet was rate-limited). A program
  change means close + redeploy under a new id, as was done once (section 2).
- **Live tables left delegated** by the devnet runs (`13Cto…`, `H1Xj…`) stay usable for more
  rounds. `HBbH…` was undelegated by the extended run. Phase 2 reuses both as house tables Pit C
  and Pit D (section 9).

# Phase 2 (web client, house dealer, house tables)

## 9. House tables, web client and house dealer

### House tables

Created with `scripts/setup-house-tables.ts --create 2 --window 60 <reused tables>` (budget guard:
refuses a table that would drop the deployer below 0.25 SOL; at most 4 house tables). The same run
normalised every window to 60 s with `set_window` (creator-only, ER, free). Deployer:
0.476770352 → 0.416126528 SOL (2 × ~0.0303 SOL). Listed in `web/src/config.ts`.

| Name | Table | Origin | Notes |
|---|---|---|---|
| Pit A | `B5DEBWv6haJGznuR3NnQY3KgxHTg9HddGUBGa2qoE9tr` | new, id 1795242369077 | create `5n8zWFCymhfnuorFcSLCK7iZx6zHSjxXWEPukkUiiet1QyripCM8anVwdkNdBVoNjJ2sKk2m5ot4XehoEKMhjH1z`, permissions `5fpBMCo5xLJxT2RbK8BsT6zHwYVA4BregC3Gou64WCLmEHwNiddUYekDZbqMEfkG8NhLJed98EHev5sBxqNUotV2` |
| Pit B | `F3rPFZsnfvm63ih7HmPwRuYLiAeeRmdXsZnPGBseX28G` | new, id 1795242375439 | create `446gEfBBAYKJzjMzktvcqY9Z6iS4VxasX3q2GEPwxZE8JndDkNHhffWgzkHCX3THhLTsCCvjfSXdVqJTmdKT41Cj`, permissions `2E61HSjkCsawHuUPU7pSft5Lu2nTjoetJHf4dqfrd6YVKiybgVpAJDvQRPESjmdNJohCQ2sAkAinmhT9JBvB8NQ9` |
| Pit C | `13CtoxNGBp4mRNMLQox1TB79HUvd9gzS5SM49ofLCr9o` | phase-1 debug table | window 20 → 60 s (`279LD6kE…`). Seat 0 is held by a phase-1 script key that was never saved: 3 playable seats |
| Pit D | `H1XjVzo11KLj4r8zZHC5nW2YNyWG2ZKn8CeWNZkWZ4Do` | phase-1 section 6 table | window 90 → 60 s (`4tygrFmk…`). Same stranded seat 0: 3 playable seats |

The stranded seat 0 on Pit C/D is a `human` seat whose owner key no longer exists. It is dealt
cards every round and never trades; the lobby shows it as a taken seat. Only that key could `leave`.

### Web client (`web/`)

Vite 6 + React 18 + TypeScript, npm workspace, imports `@outcry/client` from source (Vite alias /
TS `paths`; `client/dist` is not committed). Static bundle, relative asset base, hash routes
(`#/`, `#/t/<table>`, `#/how`), so it runs from any static host and sub-path. A `Buffer` polyfill is
the first import (the client calls `Buffer.from` at module load). Fonts are self-hosted via
Fontsource.

- Guest key: `Keypair` in `localStorage` (`outcry.session.v1`), 0 SOL; the TEE token is cached
  with its expiry. All ER transactions are sent through the token connection.
- Play now: picks a joinable table (most free seats); if all are mid-round it queues for the
  table whose bell is next and joins at the bell. `join` + `start_round(use_crank = true)` go in
  one transaction, so a guest is dealt in immediately.
- Live reads: `onAccountChange` on the TEE WebSocket (token-free, the table is public) plus a
  2.5 s polling fallback when the socket is quiet; my seat is re-read with my token on every table
  change and every 2 s. The lobby polls all four tables every 3 s.
- `take` has no price argument, so the client re-reads the table and refuses ("book moved")
  if the level changed since the click. Program errors are decoded by `client/src/errors.ts`
  from the send error: on the TEE a failed preflight comes back with an empty simulation `logs`
  array, and the code is in the error message (`custom program error: 0x…`). The message's first
  line is "Simulation failed."; phase 1 printed only that line, so it showed no reason.
- Seat hygiene (app-level, `web/src/lib/seatkeeper.ts`): wherever the guest is in the app, it
  finds the seat it holds on any house table and keeps a signed `leave` with a blockhash no older
  than ~10 s. On `pagehide` it fires that `leave` through the token URL with
  `fetch(..., { keepalive: true })`. "Leave the table" sends `leave` normally.
- Records are never skipped by a start: `join + start_round` and "Deal the next round" prepend
  `publish_records` when the settled round is still unpublished (retrying without it on
  `AlreadyPublished`). "Leave the table" does the same. A seated client also publishes if nobody
  has after 3 s. The combined transaction is confirmed on devnet: the queued, wallet co-signed
  guest join on Pit C (round 9 → 10) landed as `4LQiaNUqeNgovgmKPZxuP9RRHrHKqi9rrTSUZ5XzyJeiexta8Ke4nRDKV697i17qsAgxbCjqUFCchHUzxnrgXmna`
  with logs `PublishRecords | Join | StartRound`, and the dealer, polling every 2 s, never
  logged a publish for that round.
- Wallet (optional): Wallet Standard discovery (`@wallet-standard/app`), `solana:signTransaction`
  to co-sign `join` (the wallet signs first, then the session key adds the fee-payer signature),
  `solana:signAndSendTransaction` for `init_record` on base, `PlayerRecord` shown in the wallet
  menu. If the wallet declines or fails, the guest is seated without it (no retry loop). The e2e
  test drives this with a scripted Wallet Standard wallet: co-signed `join`, seat bound to the
  wallet, base `PlayerRecord` updated after the bell. `init_record` through a wallet and real
  extensions (Phantom etc.) were not exercised; the e2e wallet's record was created by the
  deployer (`3ttRySCC…`). A seated guest can bind later with `leave` + `join` (co-signed) in one tx.
- Reveal: scoreboard from the table, the four revealed seats (anonymous reads after the bell), a
  tape replay, and a five-step "what was private and when it flipped" story with links.

### House dealer (`scripts/house-dealer.ts`, `npm run dealer`)

`start_round` requires a seated human or the table creator, so a dealer that only uses its own
generated key cannot start a round from outside. Approach, verified on the TEE: the dealer's
0-SOL key (`~/.config/solana/outcry-devnet/house-dealer.json`, created on first run) sends
`join(free bot seat)` + `start_round(use_crank = true)` in **one** ER transaction, stays seated
through `dealing` (the 20 s retry also needs a seated signer, and `join` is rejected while
dealing), then sends `leave` as soon as the phase is `trading`. A house bot plays that seat for the
rest of the round (`bot_tick` only checks that the seat's `round` matches). Side effect: for that
round the dealer key is the permission member of one bot seat. Per table and per loop (2 s):
- `settled` with `records_round < round` → `publish_records`;
- between rounds, start only when the last bell is more than `--gap` (25 s) old, no newly seated
  human is inside the 20 s grace (first-seen time per (seat, owner); after a restart every seated
  human counts as just seen), and a re-read right before sending shows nothing changed;
- `dealing` for more than 22 s → `start_round(use_crank = false)` (VRF only, same round). This
  never fired: every deal landed within the dealer's next poll (~4 s from start to `leave`);
- `trading` more than 8 s past `trade_end_ts` → `ring_bell` (crank fallback; never needed);
- `--creator-fallback` lets the creator key (deployer, ER only) restart rounds with no seated signer.
- The TEE token (30 days on devnet) is refreshed 10 min before expiry and after 5 polls in a row
  with no table readable.
- Seen once: the dealer's `publish_records` was rejected with `RoundInProgress` (Pit C,
  round 15). A queued guest's combined `publish + join + start` at that bell landed first, so the
  round was already published and the next round running. The rejection is harmless.
It exits after `--rounds N` dealer-started rounds per table, or `--minutes M`, and only once it
holds no seat.

### Findings (TEE vs docs/expectations)

- **`join` + `start_round` in one transaction works** on the TEE, and `leave` mid-round hands the
  seat to the bot (it keeps trading the dealt hand).
- **Anchor's browser build has no `Wallet` export.** `OutcryClient` built its instruction-only
  `Program` with `new Wallet(...)`, which throws in a browser. It now passes a plain
  `{ publicKey, signTransaction, signAllTransactions }` object.
- **TEE auth works from a browser** (no CORS issue on `/auth/challenge`, `/auth/login`), and
  token-URL HTTP calls (private seat reads, every send) work from the page. Account subscriptions
  were exercised on the **anonymous** WebSocket only (the table is public); the UI shows "live
  subscription" during rounds. The tokenised WebSocket was not exercised.
- **The TEE requires a token for `sendTransaction`.** A raw `sendTransaction` to the bare RPC URL
  returns `{"error":"Missing token query param"}`. Through the token URL, a `leave` signed with a
  blockhash 45 s old still landed (so a pre-signed `leave` refreshed every ~10 s is safe).
- **Every crank tick lists the seats and their permission accounts.** `bot_tick` passes them all
  as writable, so `getSignaturesForAddress` returns one signature a second per crank. A round's
  crank runs `window + 45` ticks, so ~45 idle ticks follow the bell. When the next round starts
  within that tail (the dealer's 25 s gap), the old crank's idle ticks overlap the new crank's,
  giving two signatures a second (seen around `deal_requested_ts` on Pit B). The client (`findRoundTxs`, via seat 0) picks by time and confirms
  by logs. The seal is the `StartRound` at `deal_requested_ts`, the deal the `Deal` callback next
  to it. The bell is the earliest tick at or after `trade_end_ts` with an
  `ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1 invoke` log.
- **After the bell, round transactions are readable by anyone, including the deal.** With an
  anonymous connection, all of these return full messages and logs:
  - the human-round bell (`4ZZKyALz…`, 33 log lines including the ACL CPIs);
  - the guest's `join + start_round` (`Ns4am8a6…`);
  - a mid-round `take` that wrote two seats that were private at the time (`5CkJSJca…`);
  - the VRF `Deal` callbacks (`WKq4Ppoe…` on a bots-only round, and `3Az7sHWW…` on the final
    e2e round with a human seat).

  The spike saw such transactions redacted while the seats were private. So the TEE seems to
  evaluate redaction at query time against the current permissions. That leaks nothing new, since
  the bell reveals every hand and order. But the deal's randomness is hidden only until the bell,
  and the UI says exactly that: "redacted while the round ran; readable now". The reveal links the
  deal transaction.
- **Clock:** the TEE's `getBlockTime` was within 1 s of local time; the client still derives the
  countdown from an ER clock offset.
- **Phase-1 script keys strand seats** (Pit C/D). Every Phase 2 test key is stored
  (`e2e-guest.json`, `e2e-wallet.json`, `house-dealer.json`), and the e2e script frees any seat
  the guest holds before and after a run.
- **Tooling note:** `tsx` (esbuild `keepNames`) wraps functions in `__name(...)`, so a function
  passed to Playwright's `addInitScript` throws `__name is not defined` in the page. The mock
  wallet is therefore injected as a script string.

### End-to-end browser run (`scripts/e2e-web.ts`, real devnet, final build, dealer running)

Part 1 is the guest flow with no wallet. Part 2 connects the scripted Wallet Standard wallet,
opens a mid-round table ("seat me at the bell"), checks the co-signed binding and the base
`PlayerRecord`, then closes the page while seated to check the `pagehide` `leave`. Verbatim:

```
[   0.1s] guest (0 SOL) DcDQjBKQa1nCSW9LJx6BGDYoQ4RSMbZ3ZS75L1GiJVg5
[   4.5s] serving web/dist at http://127.0.0.1:4173/
[   6.7s] lobby shows 4 house tables:
[   6.7s]     Pit A 16 Trading, bell in 0:56 Watch
[   6.7s]     Pit B 15 Bell rang 8:01 ago Watch
[   6.7s]     Pit C 14 Bell rang 8:09 ago Watch
[   6.7s]     Pit D 12 Bell rang 8:07 ago Watch
[   7.0s] Play now -> Pit B (F3rPFZsnfvm63ih7HmPwRuYLiAeeRmdXsZnPGBseX28G)
[   9.4s] hand rendered: order "3 ♣ clubs + 3 ♦ diamonds", hand "♠ spades 3 spare ♣ clubs 1 need 2 ♥ hearts 4 spare ♦ diamonds 0 need 3", chips 200
[  12.9s] quote: offer 45 on suit 0 -> ok: Offer 45 posted. view
[  16.1s] take: Sell 7 on suit 0 -> ok: Sold 1 at 7. view
[  16.9s] trading: 2 accepted actions (take filled)
[  20.1s] waiting for the bell ...
[  69.4s] scoreboard:
[  69.4s]     1 Blue house bot 331 231 chips + 100 for the filled order
[  69.4s]     2 Gold house bot 234 134 chips + 100 for the filled order
[  69.4s]     3 Green house bot 228 228 chips, order missed
[  69.4s]     4 Red you 207 207 chips, order missed
[  70.6s] records published for the round: yes
[  70.6s] explainer link "your start transaction": 3g5iiX9yHdqkEeA1T6gPPyQBAVgtRL63wsK4YTzPv7EnnMvqzczo63pgehsYe1MAjPC8Qr6WZkGvvdPA7J831j2b
[  70.7s] explainer link "deal transaction": 2V62nPXENHKVWByK8yNZMJ68Cappxo5e3H9Dqrdys8HCy3gtnmoPV8wXFkJE55YSFLTD5pgeq5do75RpKH62Jmt
[  70.7s] explainer link "sell 1 spades @7 to Gold": 3aT428JUhbm9bxa7hGEp6UbWMGoJtQgfMmhZmZaChGbaT7pj9fLdQ72FYnPE6EcDzw28iisC7QPB9zEFqkX42otr
[  70.7s] explainer link "offer 45 spades": 2cbnzEPjZfv3gb65RLs9N3ZJjXCdjWFWGsrCs8Fgigin27X8caSw9ojxfUnEPGVojGAh9Gd6Avm5b5RujfVs2ruJ
[  70.7s] explainer link "bell transaction (rung by the crank)": zatSWJtbMwzgk9DHWiGA12S6JfkedPrqBKs9tKCiPEDSPbBPErxEN3V98aDeZySDX6LHgo3Tp8fn2r9yeFsk7Fq
[  73.0s] tx (er) join seat 0 + start round 16: 3g5iiX9yHdqkEeA1T6gPPyQBAVgtRL63wsK4YTzPv7EnnMvqzczo63pgehsYe1MAjPC8Qr6WZkGvvdPA7J831j2b
[  73.0s] tx (er) offer 45 spades: 2cbnzEPjZfv3gb65RLs9N3ZJjXCdjWFWGsrCs8Fgigin27X8caSw9ojxfUnEPGVojGAh9Gd6Avm5b5RujfVs2ruJ
[  73.0s] tx (er) sell 1 spades @7 to Gold: 3aT428JUhbm9bxa7hGEp6UbWMGoJtQgfMmhZmZaChGbaT7pj9fLdQ72FYnPE6EcDzw28iisC7QPB9zEFqkX42otr
[  75.2s] left the table
[  79.1s] wallet connected in the UI: 9Uq2wAd5VgarAD2brv3SPi2iSZSnwJFCGPPD7PqJutU7 (record rounds before: 2)
[  80.2s] part 2: Pit C is trading; opening it with ?play=1
[  80.5s] queued: "Seating you at the bell in 0:11."
[  93.9s] seated at the bell in seat 1, round 16; seat wallet = the connected wallet (co-signed join)
[ 152.4s] round 2 settled; waiting for the base-layer PlayerRecord
[ 156.5s] PlayerRecord on base: rounds 2 -> 3, best 300, last round 16, last table 13Ctox
[ 186.7s] explorer link for the bell renders the transaction: no (not confirmed by the page within 30 s)
[ 189.1s] page closed while seated -> seat freed by the pagehide leave: yes
[ 189.1s] E2E PASS
```

Notes on the run:
- Earlier runs moved the e2e wallet's record 0 → 1 → 2; this run 2 → 3.
- **Explorer links are not verified.** explorer.solana.com answered headless Chromium with a
  "Vercel Security Checkpoint: Failed to verify your browser" page, so the run could not check
  that the custom-cluster link renders an ER transaction. The anonymous `getTransaction` calls
  such a page would make do succeed against the TEE (see the findings above), and the TEE serves
  browser requests with CORS (the app relies on it). After the run, the only change to the e2e
  script was dropping the screenshot of that checkpoint page.
- An earlier run exercised a rejection: `take: Buy 12 on suit 0 -> rejected: Rejected: book moved`
  (`NoQuote`; a bot re-quoted between the click and the send).
- Screenshots of the final run are in `docs/screenshots/`: lobby, table, trading and reveal on a
  phone, reveal, how it works. Their clock is UTC, and they contain only throwaway devnet keys.

### House dealer log (`npm run dealer -- --rounds 2`, verbatim)

This run used the dealer with the token refresh. The `--minutes` cut-off was added afterwards and
checked by the separate 3-minute run below; it does not affect `--rounds` runs.

Run alongside an e2e run: the `DcDQjB` lines are the e2e guest, the dealer gives it the 20 s
grace. Pit B's round 7 was the guest's, so the dealer's two rounds there are 8 and 9. Seat 0 on
Pit C and Pit D is the stranded phase-1 seat.

```
house dealer 8FaQ3PJF4FDk6uhmHrokuwboWRedoyEvqXxjx2Kos8GA (0 SOL, ER only), 4 tables, gap 25s, grace 20s, rounds 2; TEE token valid until 2026-12-21T07:03:25.603Z
2026-11-21T07:03:28.599Z [Pit A] start round 6 (bots 4, humans 0; dealer joins seat 3, crank on) ok ZcqKbVdDK8QWnjQEhd66eovmiJH8ffYGWAAJ3a9gBUT1272RqWKtvmPFf7ntDfL6YGWQHWnWauQuEm88KWNPNFF
2026-11-21T07:03:28.601Z [Pit C] human seated at seat 0 (5PzwVZ), grace 20s
2026-11-21T07:03:28.601Z [Pit C] waiting: human at seat 0 in pre-round grace
2026-11-21T07:03:28.601Z [Pit D] human seated at seat 0 (CTCFaf), grace 20s
2026-11-21T07:03:28.602Z [Pit D] waiting: human at seat 0 in pre-round grace
2026-11-21T07:03:32.666Z [Pit A] round 6 trading: leave seat 3 (back to the house bot) ok 5B9m9qjzMuj5tEm668H9ARPJmLqZz2QEjE1coaNSbkmBiXNceFDcJ4H8fx2WmcBKHn6kTwLhwzHfwXJcxdN2F5CY
2026-11-21T07:03:34.929Z [Pit A] round 6 trading, bell due at 07:04:27Z
2026-11-21T07:03:34.929Z [Pit B] human seated at seat 1 (DcDQjB), grace 20s
2026-11-21T07:03:34.931Z [Pit B] round 7 trading, bell due at 07:04:33Z
2026-11-21T07:04:00.025Z [Pit C] start round 7 (bots 3, humans 1; dealer joins seat 3, crank on) ok 2g8FqGoZCq9q1cZudMLR3xQpPRLBgKYpJEXHm3av52JcBtQL7A9B9RMyhQBXefHcwVgvKe4yUDtt6GXRacZ46xvC
2026-11-21T07:04:04.394Z [Pit C] round 7 trading: leave seat 3 (back to the house bot) ok 2AphL3xQptq86RQrkZHhXDjs3danoDc3dqWb1HnmxPFznPKGr5YLcqX463FWhy6gykBoqCiWSGrYYAcMjsqLznqy
2026-11-21T07:04:06.711Z [Pit C] round 7 trading, bell due at 07:04:58Z
2026-11-21T07:04:13.392Z [Pit D] start round 6 (bots 3, humans 1; dealer joins seat 3, crank on) ok uVoirhrbiNzeZUTeaHCJEgmimhRQuhczST3pvfk9txBjv9Wm67uu2sdYzDvyErTgN949kj9WJ7dfJsvUWghg9hR
2026-11-21T07:04:17.331Z [Pit D] round 6 trading: leave seat 3 (back to the house bot) ok 4fDLHfV3La7evg5YJhA5CyyqHEoCrWY8FdsXuAByxoSYJAdACdMRRQpzc47bnkEQELX6TBKTwZGn6rZhHcm2TBUZ
2026-11-21T07:04:19.586Z [Pit D] round 6 trading, bell due at 07:05:12Z
2026-11-21T07:04:30.714Z [Pit A] round 6 settled (scores 377/256/269/298, ranks 0/3/2/1): publish_records ok 4gqb84V9pvANRFq91TkUGvCLuLswmyrxyEXdKUffqbHx1U3Ns8oArj8f5GVXkdUzTuvkVYmWc9W3fdzoz8FQcQbw
2026-11-21T07:04:32.965Z [Pit A] round 6 settled; next deal not before 07:04:52Z
2026-11-21T07:04:36.957Z [Pit B] round 7 settled (scores 271/208/234/287, ranks 1/3/2/0): publish_records ok MB9kMNrNKdENjg9qVJVhguwJ7niFXYbpf4TUn8MRxS9eqHZkSHLDNuAp7Dtsi1GG6U2HwgoKcDwkYE3pFNRuDey
2026-11-21T07:04:39.205Z [Pit B] round 7 settled; next deal not before 07:04:58Z
2026-11-21T07:04:56.892Z [Pit A] start round 7 (bots 4, humans 0; dealer joins seat 3, crank on) ok 25zHWbpjJG52txUCVsoKjSanfn87VK5h1nySnBSH1CJzripwnNvUc8GjK2YXBWbBw16ggJcoaFRQhVTZfk8suUSz
2026-11-21T07:05:01.326Z [Pit A] round 7 trading: leave seat 3 (back to the house bot) ok 58K5kCh1uJrHywYYKxmVrXbgUbEN1Kt1KuEP4yN9EykN42pQL2WDKhnyuN5aeDTMujKcmnANYyxjof9TzCL15jLF
2026-11-21T07:05:03.542Z [Pit B] start round 8 (bots 4, humans 0; dealer joins seat 3, crank on) ok 9oJQfWeruMa49V5gTngPvJm5kZfAZLigBNx6HfPDuygsradc23Apbu2LXoETZ4yAEcemRZKYRgntqJKjbwsQrYX
2026-11-21T07:05:05.744Z [Pit C] round 7 settled (scores 200/249/216/335, ranks 3/1/2/0): publish_records ok PNdmv1pgdHmLbveZd5oDf3WSUTy4VbsgvaH3pb7FrnyfRYqQ9r3dRqTYLNJ4ktdhU66KpitybkJSpWLbecRrykX
2026-11-21T07:05:08.029Z [Pit A] round 7 trading, bell due at 07:05:55Z
2026-11-21T07:05:09.924Z [Pit B] round 8 trading: leave seat 3 (back to the house bot) ok 4PfzAP7sJadxqhSx87amPjqz6we31MMtbaUT3jcnZRPbdWTjFstvQY6WEk8wt9czw1QJHm2JhjBgvahG1yCmo4Hj
2026-11-21T07:05:09.924Z [Pit C] round 7 settled; next deal not before 07:05:23Z
2026-11-21T07:05:12.180Z [Pit B] round 8 trading, bell due at 07:06:02Z
2026-11-21T07:05:16.228Z [Pit D] round 6 settled (scores 200/249/320/331, ranks 3/2/1/0): publish_records ok 5Qxdq5UMpP5us82TiDgarCBgrnXy9HBQsJzobEe7DGsGZX4tjySq8TgRZgUrRPjqMgqfuJ2yd98Z8BsUrdse6kAQ
2026-11-21T07:05:18.484Z [Pit D] round 6 settled; next deal not before 07:05:37Z
2026-11-21T07:05:27.227Z [Pit C] start round 8 (bots 3, humans 1; dealer joins seat 3, crank on) ok GUtCW7FZ2T4x1oQXzG5MCATc67rBxjyevz8hgjhkoxW7H2LPoSxYEs7YsybWyk8nBczhkGvcK753mV24zRermPc
2026-11-21T07:05:32.387Z [Pit C] round 8 trading: leave seat 3 (back to the house bot) ok 2RCmj2tjSn4W9UY1hZnNHTesn29SWRMuUsgE4xv1xj9nLRrRtATcAnZN3HRPj1YjTdZgSEhHCtJmjr5P8dUjDEs2
2026-11-21T07:05:35.118Z [Pit C] round 8 trading, bell due at 07:06:25Z
2026-11-21T07:05:41.756Z [Pit D] start round 7 (bots 3, humans 1; dealer joins seat 3, crank on) ok 62sRzDkWNgZQ71pse5L9Ctj83mbxC8g9QDGgEZQDGhXNmJbn7zHV1dPaGQhBqpbYQT3Y7M6SLoK41RQtb7BxD6nS
2026-11-21T07:05:45.780Z [Pit D] round 7 trading: leave seat 3 (back to the house bot) ok 3hL7tXAXqZBfQhkT8JVtLG6reS6UP4TAXhXQ7mypHuUFWGjRmwMqtVaj7yRSPnGf8BK6PeRCydL5GWyfcM7RbL2G
2026-11-21T07:05:48.043Z [Pit D] round 7 trading, bell due at 07:06:40Z
2026-11-21T07:05:58.764Z [Pit A] round 7 settled (scores 258/348/341/253, ranks 2/0/1/3): publish_records ok 3asJvwXecB8xchJfchUtafeYPLAy7iA3ssSNY98JtBxuHEhrdwUjLUxxtwe3Rctid5nsugofYkZ8HyAavE8fFEea
2026-11-21T07:06:05.463Z [Pit B] round 8 settled (scores 328/295/300/277, ranks 0/2/1/3): publish_records ok VpdBNVoz6Re7M2WkABdVpr39d7PSd3AS6b67xLVjYZvCVXP6LoR55vHaCGdgPyd7oz1ct87QGATBwF1ffKPcWUy
2026-11-21T07:06:08.213Z [Pit B] round 8 settled; next deal not before 07:06:27Z
2026-11-21T07:06:21.826Z [Pit A] human seated at seat 1 (DcDQjB), grace 20s
2026-11-21T07:06:21.826Z [Pit A] round 8 trading, bell due at 07:07:21Z
2026-11-21T07:06:28.071Z [Pit C] round 8 settled (scores 200/268/240/192, ranks 2/0/1/3): publish_records ok 28qYSECjh4VNtq2DHjf3yojNNCAbW4qZfLsVuPFuxdcQMndewMuaPPKDJA1g84UGJv4zuqxvunYLECWYNbbLMYPg
2026-11-21T07:06:32.355Z [Pit B] start round 9 (bots 4, humans 0; dealer joins seat 3, crank on) ok 4hMHx128yY3r6zpgbwrjrmiDEiVBwf9HKrUnDR8wMLQsj5ESMhd8mgY5kkyWWEkEPzExhCSkUFNm6U7QbmsDVXLT
2026-11-21T07:06:36.279Z [Pit B] round 9 trading: leave seat 3 (back to the house bot) ok 5t5ETWDJszns4P7WDgeU27StWvSofijxUpTMpDEYnxkRQQnowD9rafPYNY1TZCxowRSFRUVgKQH8faDZM2thG4MS
2026-11-21T07:06:39.225Z [Pit B] round 9 trading, bell due at 07:07:30Z
2026-11-21T07:06:43.164Z [Pit D] round 7 settled (scores 200/247/368/185, ranks 2/1/0/3): publish_records ok 3rxjEpq4MY1kAdmJHkiHxSTBNin7v55Jg7vYwEnDUHhxAcDNQ5yTDWwkZxjcChmHGUYmPwTvg29ELArCovZHvT9G
2026-11-21T07:07:23.845Z [Pit A] round 8 settled (scores 249/230/237/284, ranks 1/3/2/0): publish_records ok baUA8MijeCiyhcTv5Fzt9SGht4Nuvp3m9MwPVGmSAGbF4tx59P8dzHQqekjg9aa8UXQnYVgbZSLtdZCLmKPey6Q
2026-11-21T07:07:34.574Z [Pit B] round 9 settled (scores 275/275/379/271, ranks 1/2/0/3): publish_records ok 3L13SVQgVycNMZ5oE4Pp3QH6NFhdAzEPkbUPVjq38UMRgWQXuuSFWNoiAVdWZsUxBsHwkNfxfGNScHs6N66hRh6k
dealer stopping (rounds done); completed rounds: Pit A=6,7 Pit B=8,9 Pit C=7,8 Pit D=6,7
```

Two earlier `--rounds 2` runs (before the log wording and token refresh changes) also completed
2 rounds per table, so the dealer has started and published at least 24 rounds at 0 SOL. A later
`--minutes` run showed the time limit did not stop new starts right before the exit. The dealer now
starts no round in the last 2 minutes, so it publishes every bell it caused before it exits; a
3-minute run checked this (excerpt, verbatim):

```
house dealer 8FaQ3PJF4FDk6uhmHrokuwboWRedoyEvqXxjx2Kos8GA (0 SOL, ER only), 4 tables, gap 25s, grace 20s, rounds unlimited, 3 min max; TEE token valid until 2026-12-21T07:15:52.088Z
...
2026-11-21T07:16:47.368Z [Pit B] start round 15 (bots 4, humans 0; dealer joins seat 3, crank on) ok 3WdtPicUieXmMBTgkGaBwzLPmBhUWYqoLAqCLrvyvkCXcJ8sqNrfQsk33Wr93fGkHTKTqhoB5CuxhmpgmHNYp3L5
...
2026-11-21T07:17:38.426Z [Pit A] round 15 settled (scores 341/254/261/344, ranks 1/3/2/0): publish_records ok tQ47XbmftYeGyxMFsSLnumP5tXQyekN6uku6TgddTv5cHtS5oYKPeqU51hyfyLopLoB7xbZNYwVHVFQqagKH2tR
2026-11-21T07:17:42.405Z [Pit C] round 14 settled (scores 200/317/300/183, ranks 2/0/1/3): publish_records ok SUVVc1jryDLnSzYYcofFsJdPienGmPfQjJEnWspkpvWxoi6cALWBSQhnoipE9r6idbJkFtkyWtz7MGJuh5rAVPj
2026-11-21T07:17:44.102Z [Pit D] round 12 settled (scores 200/234/309/357, ranks 3/2/1/0): publish_records ok 3V8CiCtHJRU2pyX4dZQsRFAGj5vSeKMpCp4RtAYKALFyMdXTAXLbs6HaVxPZUXJHUPn7mxczxr1Z11pUi8DM3x9s
2026-11-21T07:17:50.311Z [Pit B] round 15 settled (scores 343/216/304/337, ranks 0/3/2/1): publish_records ok 2JNAwRGAs8FE5bZst2oMymbpMyZbQ6TkEmUq8BdtsAg3UcqDs4iD1jhA1LoMa5HavEo1j9sUK2V5NyUkFA94oTDA
dealer stopping (time limit); completed rounds: Pit A=15 Pit B=15 Pit C=14 Pit D=12
```

### Phase 2 costs

- 2 new tables: 0.0606 SOL.
- `init_record` for the e2e wallet: ~0.0012 SOL (deployer pays).
- Dealer, e2e guest and every round: 0 SOL.
- Deployer balance: 0.476770352 SOL before phase 2, 0.414968368 SOL after.

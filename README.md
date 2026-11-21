# Outcry

Outcry is a 60-second open-outcry trading pit for four players, built for MagicBlock Solana Blitz
v10 (Entertainment Finance). Each player is dealt eight cards from a 32-card deck, 200 chips and a
secret order such as "4 clubs + 2 diamonds". Everyone quotes bids and offers per suit on a shared
public book and hits each other's quotes; at the bell your score is your chips, plus 100 if you hold
your whole order. Hands and orders are truly hidden: they live in accounts on a MagicBlock **Private
Ephemeral Rollup** (TEE) that only their owner can read, the deal comes from **VRF**, house bots and
the bell run on an on-chain **crank**, and results are written back to Solana by a **Magic Action**.
A guest plays from the browser with a throwaway key holding 0 SOL: no wallet, no fees, no server.

## How to play (guest flow)

1. Open the web app and press **Play now**. Your browser creates a session keypair (kept in
   `localStorage`, 0 SOL) and signs the TEE's auth challenge to get a read token.
2. You are seated in a free house-bot seat and the round is dealt in the same transaction
   (`join` + `start_round` with the crank). If every table is mid-round you are seated at the next
   bell.
3. Your ticket shows your private hand, chips and order (read with your token). The book shows
   every jacket's bid / offer per suit. **Buy** / **Sell** hit the best offer / bid in one click;
   the price box + **Bid** / **Offer** posts your own quote (click a quote chip to cancel it).
   Rejections are explained in plain words ("book moved", "no card", "no chips").
4. At the bell the four seats flip public: the reveal shows the scoreboard, every hand and order,
   which orders filled, a replay of the round's tape and a short "what was private and when it
   flipped" story with explorer links.
5. Stay for the next round (with the house dealer running it deals ~25 s after the bell, or press
   **Deal the next round**), or **Leave the table** (a house bot takes the seat back).

Optional: connect a Wallet Standard wallet (Phantom, Solflare, Backpack, set to devnet). It
co-signs `join` so the seat is bound to the wallet's on-chain `PlayerRecord`; the wallet pays
~0.0012 SOL once for `init_record`. Playing never depends on it.

## How the MagicBlock pieces are used, and why

| Piece | What Outcry does with it | Why |
|---|---|---|
| **Ephemeral Rollup** | A table and its four seats are delegated once to the TEE validator; every join, quote, take, bell and record request after that is a rollup transaction. Tables stay delegated round after round. | Real-time trading needs quick confirmations (a few seconds or less from click to confirmed in the browser tests), and fees of zero let a 0-SOL guest key trade. No commits during play, so no per-round cost. |
| **Private ER (TEE permissions)** | Each seat has an ephemeral permission. `start_round` makes it private with the human owner as its only member (flags 0, so no transaction visibility); bot seats get no player member. `ring_bell` flips all four public. | The game is about hidden information. Reads are gated by the TEE: the owner's token sees the seat, everyone else gets `null`. While the round runs, the deal transaction is redacted for every viewer. After the bell, when every hand is public anyway, it becomes readable. |
| **VRF** | `start_round` requests randomness from the ephemeral queue; the callback (`deal`, 20-35k CU) shuffles, deals 8 cards per seat and draws four jointly feasible orders straight into the sealed seats. | Nobody, including the table creator, can choose the deal or see it before the bell. |
| **Crank** | `start_round` schedules a native rollup crank (1 Hz, `window + 45` ticks) running `bot_tick`: one house-bot action per tick, and the bell when the window ends. | Bots and the bell run on chain inside the rollup, so a judge can play alone with no server. Bots only see their own seat and the public book. |
| **Magic Action** | `publish_records` schedules a standalone base-layer action (`record_round`) authenticated by the table PDA as escrow authority. It updates each wallet-bound `PlayerRecord` on Solana. | Lifetime stats live on the base layer without committing the table (no commit nonce, no per-round fee; the validator pays the base fee). |

## Architecture

```
  Browser (guest)                 Private Ephemeral Rollup (TEE, devnet-tee.magicblock.app)         Solana devnet
  session key, 0 SOL   --ER tx-->  +--------------------------------------------------------+
  TEE token: reads                 |  Table (public): book, tape, scores, clock             |  <--delegate once--  program AUnuo...
  only its own seat                |  Seat x4 (private to owner during a round, public      |                      delegation program
                                   |          after the bell; VRF writes the deal here)     |
  House dealer (Node)  --ER tx-->  |  VRF callback `deal`      Crank: `bot_tick` 1 Hz       |  --Magic Action-->   PlayerRecord per wallet
  0 SOL, starts rounds,            |                           (bots + bell)                |
  publishes records                +--------------------------------------------------------+
```

The web app's "How it works" page has the same picture as an SVG. Program internals, account
layouts, measured costs and devnet evidence are in [NOTES.md](NOTES.md).

## Devnet deployment

| | |
|---|---|
| Program | [`AUnuoAP1BoujRzy4SSPeiJLoiWKPPsHrAcFqcsiSyWVv`](https://explorer.solana.com/address/AUnuoAP1BoujRzy4SSPeiJLoiWKPPsHrAcFqcsiSyWVv?cluster=devnet) |
| TEE rollup RPC | `https://devnet-tee.magicblock.app` (validator `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`) |
| House tables | Pit A `B5DEBWv6haJGznuR3NnQY3KgxHTg9HddGUBGa2qoE9tr`, Pit B `F3rPFZsnfvm63ih7HmPwRuYLiAeeRmdXsZnPGBseX28G`, Pit C `13CtoxNGBp4mRNMLQox1TB79HUvd9gzS5SM49ofLCr9o`, Pit D `H1XjVzo11KLj4r8zZHC5nW2YNyWG2ZKn8CeWNZkWZ4Do` (60 s window) |

Deployment settings (program id, RPC URLs, house tables) live in one file:
[`web/src/config.ts`](web/src/config.ts).

## Cost per round

Measured on devnet (NOTES.md section 3):

| | Lamports |
|---|---:|
| One-time table setup (rent + delegation deposits + fees) | ~31.5M (0.0315 SOL) |
| Per round, for players and the table creator (all ER transactions, VRF, crank) | **0** |
| Record Magic Action per round | 0 to the app (validator pays the base fee) |
| `PlayerRecord`, once per wallet (optional) | 1,153,160 |

## Running it

Requirements: Node 20+, and for the program: Rust, Solana CLI and Anchor 1.1.2.

```bash
npm install                                   # root + workspaces (client, web)

# program + tests (the deployed binary is this build: sha256 50ceff13...)
anchor build -p outcry
cargo test --manifest-path tests-magicsvm-rs/Cargo.toml   # MagicSVM suite, 11 tests
cargo test -p outcry --lib                                # game logic unit tests

# one scripted devnet round (deployer pays ~0.0315 SOL for a fresh table)
npx tsx scripts/devnet-round.ts 90

# web app
npm run dev -w web                            # dev server
npm run build -w web                          # type-check + static bundle in web/dist
npm run preview -w web                        # serve web/dist on http://localhost:4173

# browser end-to-end test against real devnet (installs headless Chromium on first run)
npm run build -w web && npm run e2e-web

# house dealer: keeps the house tables moving (0 SOL per round, ER transactions only)
npm run dealer                                # run until Ctrl-C
npm run dealer -- --rounds 2                  # stop after 2 dealer-started rounds per table
npm run table-status -- <table> [<table> ...] # print table state from the rollup
```

The dealer generates its own key on first run in `~/.config/solana/outcry-devnet/house-dealer.json`
(never in the repo). It needs no SOL. Run it under any process supervisor you like (pm2,
`nohup npm run dealer &`, a container); it has no systemd dependency. Options: `--gap SECS`
(pause after a bell, default 25), `--minutes M`, `--tables a,b`, `--creator-fallback` (lets the
table creator key restart a round that has no seated signer).

## Deploying the web app

`npm run build -w web` produces a fully static bundle in `web/dist` with relative asset URLs and
hash routes, so it runs from any static host and any sub-path. No environment variables or secrets
are needed. `web/dist` includes `_redirects` (Cloudflare Pages / Netlify) and `vercel.json` (Vercel)
SPA fallbacks.

```bash
npm install && npm run build -w web

# Cloudflare Pages
npx wrangler pages deploy web/dist --project-name outcry

# Vercel (static, prebuilt)
npx vercel deploy web/dist --prod

# Netlify
npx netlify deploy --dir web/dist --prod

# Anything else: upload the contents of web/dist (e.g. GitHub Pages, S3, nginx).
```

## Known limits

- **Seats can be stranded.** `leave` needs the seat owner's signature and the frozen program has no
  kick. The web app sends `leave` when you leave and fires a pre-signed `leave` on page close. A
  guest whose browser dies without either (crash, lost network) keeps a human seat until the same
  browser comes back. Pit C
  and Pit D each carry one such seat from the phase-1 scripts (3 playable seats each).
- **Joining only between rounds.** `join` is rejected while a round is dealing or trading; "Play
  now" prefers an open table and otherwise seats you at the next bell. The dealer leaves a 25 s gap.
- **`take` has no price argument.** The client re-reads the book right before sending and refuses
  if the quote moved, but a re-quote landing in the same moment could still fill at the new price.
- **Records are at-most-once** and only for wallet-bound seats; see NOTES.md section 8.
- **A round stuck in `dealing`** can only be retried by a seated player or the table creator
  (`start_round` after 20 s). The web client retries automatically while its player is seated.
  The dealer retries rounds it started, because it stays seated until the deal lands. Other rounds
  it retries only with `--creator-fallback`. No deal has been late in any devnet run so far.
- **Wallet path tested with a mock wallet.** The e2e test drives the co-signed `join` through a
  scripted Wallet Standard wallet. It has not been run against a real browser extension. Without
  the deployer key, the e2e test skips the base `PlayerRecord` check: its mock wallet has no
  record and 0 SOL.
- **Explorer links for rollup transactions are unverified.** They open Solana Explorer with the
  TEE RPC as a custom cluster. Explorer blocks headless browsers, so the e2e test could not confirm
  they render. Transactions touching private seats only become readable after the bell.
- **Closing the tab mid-round frees the seat** through the pre-signed `leave`. Reloading the page
  does too, so a reload mid-round hands your hand to a bot.
- **Devnet only, play money.** The TEE rollup is MagicBlock's public devnet endpoint.

## Credits

Third-party code, SDKs and assets used, with sources and licences:

| Item | Use | Source | Licence |
|---|---|---|---|
| MagicBlock Ephemeral Rollups SDK (Rust `ephemeral-rollups-sdk` 0.18.0, TS `@magicblock-labs/ephemeral-rollups-sdk` 0.18.0) | delegation, permissions, VRF, crank, Magic Actions, TEE auth | github.com/magicblock-labs/ephemeral-rollups-sdk | MIT |
| MagicSVM 0.3.0 | in-process base + ER test ledgers | github.com/magicblock-labs/magicsvm | Apache-2.0 |
| Anchor (`anchor-lang` 1.1.2, `@coral-xyz/anchor` 0.32.1) | program framework, instruction builders | github.com/coral-xyz/anchor (solana-foundation/anchor) | Apache-2.0 (Rust); MIT OR Apache-2.0 (TS) |
| bytemuck | zero-copy table layout | github.com/Lokathor/bytemuck | Zlib OR Apache-2.0 OR MIT |
| `@solana/web3.js` 1.x | RPC, transactions | github.com/solana-foundation/solana-web3.js | MIT |
| Wallet Standard (`@wallet-standard/app`, `@wallet-standard/base`, `@solana/wallet-standard-features`) | optional wallet discovery and signing | github.com/wallet-standard/wallet-standard, github.com/anza-xyz/wallet-standard | Apache-2.0 |
| React 18, React DOM | web UI | github.com/facebook/react | MIT |
| Vite 6, `@vitejs/plugin-react` | bundler | github.com/vitejs/vite | MIT |
| `buffer`, `bs58`, `tweetnacl` | browser Buffer polyfill, base58, ed25519 signing | github.com/feross/buffer, github.com/cryptocoinjs/bs58, github.com/dchest/tweetnacl-js | MIT, MIT, Unlicense |
| Archivo (via `@fontsource-variable/archivo`) | identity and UI type (variable width) | files from github.com/google/fonts via Fontsource | SIL OFL 1.1 |
| Doto (via `@fontsource-variable/doto`) | dot-matrix numerals on the price board and bell clock | files from github.com/google/fonts via Fontsource | SIL OFL 1.1 |
| Kalam (via `@fontsource/kalam`) | pencil writing on trading cards | files from github.com/google/fonts via Fontsource | SIL OFL 1.1 |
| Playwright (`playwright-core`) | headless browser e2e test | github.com/microsoft/playwright | Apache-2.0 |
| TypeScript, tsx | type-checking, script runner | github.com/microsoft/TypeScript, github.com/privatenumber/tsx | Apache-2.0, MIT |
| MagicBlock Engine integration examples | reference only (patterns for VRF, permissions, crank, Vite setup); no code copied verbatim | github.com/magicblock-labs/magicblock-engine-examples | MIT |
| MagicBlock dev skill | reference documentation used while building | github.com/magicblock-labs/magicblock-dev-skill | MIT |

Icons: none. Suit symbols are Unicode characters; the favicon and diagram are original SVG.

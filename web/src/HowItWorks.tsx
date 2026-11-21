import { PROGRAM_ID, TEE_RPC } from "./config";
import { AddrLink } from "./ui";

export function HowItWorks() {
  return (
    <main className="how">
      <h1>How Outcry works</h1>
      <p className="lede">
        Every card, chip and trade lives on chain. The trick is where it lives and who can read it at each moment.
      </p>

      <Diagram />

      <div className="how-grid">
        <section>
          <h2>Ephemeral Rollup: the trading floor</h2>
          <p>
            A table and its four seats are delegated once from Solana to a MagicBlock Ephemeral Rollup. Every quote,
            take and bell after that is a rollup transaction: no waiting on Solana blocks and no fee, so a guest key
            with 0 SOL can trade. The tables stay delegated round after round.
          </p>
        </section>
        <section>
          <h2>Private rollup permissions: hidden hands</h2>
          <p>
            The rollup runs inside a TEE (Intel TDX). Each seat has a permission account. When a round starts it turns
            private with the seat owner's key as its only reader, so your browser signs a challenge, gets a token and
            sees your hand while everyone else gets nothing. Bot seats have no player reader. At the bell all four flip
            public for the reveal.
          </p>
        </section>
        <section>
          <h2>VRF: a deal nobody controls</h2>
          <p>
            Starting a round asks MagicBlock's VRF oracle for randomness. Its callback shuffles 32 cards, deals eight per
            seat and draws four secret orders that can all be filled at once. The callback writes straight into the sealed
            seats, and the TEE redacts its transaction until the bell makes every hand public.
          </p>
        </section>
        <section>
          <h2>Crank: bots and the bell, on chain</h2>
          <p>
            The same transaction schedules a native rollup crank that ticks once a second. Each tick moves one house bot,
            which sees only its own seat and the public book, and the final tick rings the bell. No server runs the game.
          </p>
        </section>
        <section>
          <h2>Magic Action: results on Solana</h2>
          <p>
            After the bell, <code>publish_records</code> schedules a Magic Action that runs on the Solana base layer and
            updates the player record of every wallet-bound seat. No commit, no fee for the player.
          </p>
        </section>
        <section>
          <h2>The rules</h2>
          <p>
            Four suits, eight cards each. You start with eight cards, 200 chips and an order such as "4 clubs and 2
            diamonds". Quote a bid or offer per suit, or hit someone else's. At the bell your score is your chips, plus 100
            if you hold your whole order.
          </p>
        </section>
      </div>
      <p className="how-foot">
        Program <AddrLink addr={PROGRAM_ID} layer="base">{PROGRAM_ID}</AddrLink> on Solana devnet. Rollup endpoint{" "}
        <code>{TEE_RPC.replace(/^https:\/\//, "")}</code>.
      </p>
    </main>
  );
}

/** Base layer, rollup, TEE boundary and the five MagicBlock pieces in one picture. */
function Diagram() {
  return (
    <figure className="diagram">
      <svg viewBox="0 0 860 400" role="img" aria-labelledby="dg-title dg-desc">
        <title id="dg-title">Outcry architecture</title>
        <desc id="dg-desc">
          Players' browsers send free transactions to the private ephemeral rollup inside a TEE, where the table, sealed seats,
          VRF and crank run. Tables are delegated once from Solana; after each bell a Magic Action writes player records back to Solana.
        </desc>
        <defs>
          <marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
          </marker>
        </defs>
        {/* browsers */}
        <g className="dg-node">
          <rect x="20" y="40" width="170" height="120" rx="6" />
          <text x="105" y="70" className="dg-h">Your browser</text>
          <text x="105" y="94">session key, 0 SOL</text>
          <text x="105" y="114">TEE token</text>
          <text x="105" y="134">reads only your seat</text>
        </g>
        <g className="dg-node dg-bot">
          <rect x="20" y="230" width="170" height="80" rx="6" />
          <text x="105" y="262" className="dg-h">House dealer</text>
          <text x="105" y="284">starts rounds, 0 SOL</text>
        </g>
        {/* TEE boundary */}
        <rect x="250" y="20" width="358" height="310" rx="10" className="dg-tee" />
        <text x="429" y="44" className="dg-tee-label">Private Ephemeral Rollup (TEE)</text>
        <g className="dg-node">
          <rect x="275" y="62" width="320" height="64" rx="6" />
          <text x="435" y="88" className="dg-h">Table (public)</text>
          <text x="435" y="110">book, tape, scores, clock</text>
        </g>
        {[0, 1, 2, 3].map((i) => (
          <g key={i} className={`dg-seat dj${i}`}>
            <rect x={275 + i * 82} y="146" width="74" height="70" rx="6" />
            <text x={312 + i * 82} y="176" className="dg-h">Seat {i + 1}</text>
            <text x={312 + i * 82} y="198">sealed</text>
          </g>
        ))}
        <g className="dg-node dg-vrf">
          <rect x="275" y="238" width="150" height="70" rx="6" />
          <text x="350" y="266" className="dg-h">VRF</text>
          <text x="350" y="288">deals into seats</text>
        </g>
        <g className="dg-node dg-crank">
          <rect x="445" y="238" width="150" height="70" rx="6" />
          <text x="520" y="266" className="dg-h">Crank</text>
          <text x="520" y="288">bots + bell, 1 Hz</text>
        </g>
        {/* base */}
        <g className="dg-node dg-base">
          <rect x="680" y="40" width="160" height="290" rx="6" />
          <text x="760" y="70" className="dg-h">Solana devnet</text>
          <text x="760" y="110">program</text>
          <text x="760" y="140">delegation</text>
          <text x="760" y="200">player records</text>
          <text x="760" y="222">(wallet-bound)</text>
        </g>
        {/* arrows */}
        <g className="dg-arrows">
          <path d="M190 100 H270" markerEnd="url(#ah)" />
          <text x="230" y="92" className="dg-small">trade</text>
          <path d="M190 270 H270 V230" markerEnd="url(#ah)" />
          <path d="M350 238 V220" markerEnd="url(#ah)" />
          <path d="M520 238 V220" markerEnd="url(#ah)" />
          <path d="M680 130 H612" markerEnd="url(#ah)" />
          <text x="644" y="120" className="dg-small">delegate</text>
          <path d="M600 190 H675" markerEnd="url(#ah)" />
          <text x="644" y="180" className="dg-small">Magic</text>
          <text x="644" y="208" className="dg-small">Action</text>
        </g>
        <text x="435" y="372" className="dg-foot">At the bell the four seat permissions flip public and every hand is revealed.</text>
      </svg>
    </figure>
  );
}

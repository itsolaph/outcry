import { PROGRAM_ID, TEE_RPC } from "./config";
import { AddrLink } from "./ui";

export function HowItWorks() {
  return (
    <main className="how container">
      <header className="how-head">
        <h1>How Outcry works</h1>
        <p className="lede">
          Every card, chip and trade lives on chain. What changes during a round is where it lives and who is allowed to read
          it.
        </p>
      </header>

      <div className="cols">
        <div className="col-main how-steps">
          <section>
            <h2>The rules</h2>
            <p>
              The deck has four suits of eight cards. You start with eight cards, 200 chips and a secret order such as “4 clubs
              and 2 diamonds”. Post a bid or an offer on any suit, or take someone else’s. When the bell rings, your score is
              your chips, plus 100 if you hold your whole order.
            </p>
          </section>
          <section>
            <h2>The trading floor is an Ephemeral Rollup</h2>
            <p>
              Each table and its four seats are delegated once from Solana to a MagicBlock Ephemeral Rollup, and they stay
              there round after round. Every quote, take and bell is a rollup transaction. Nothing waits on Solana blocks and
              nothing costs a fee, so a guest key holding 0 SOL can trade.
            </p>
          </section>
          <section>
            <h2>Private rollup permissions hide the hands</h2>
            <p>
              The rollup runs inside a TEE (Intel TDX), and every seat has a permission account. When a round starts, each
              seat turns private with its owner’s key as the only reader. Your browser signs a challenge, gets a token and
              sees your hand. Everyone else sees nothing. Bot seats have no player reader. At the bell all four turn public
              for the reveal.
            </p>
          </section>
          <section>
            <h2>VRF deals the cards</h2>
            <p>
              Starting a round asks MagicBlock’s VRF oracle for randomness. Its callback shuffles the 32 cards, deals eight to
              each seat and draws four secret orders that can all be filled at once. The callback writes straight into the
              sealed seats, and the TEE hides its transaction until the bell makes every hand public.
            </p>
          </section>
          <section>
            <h2>A crank moves the bots and rings the bell</h2>
            <p>
              The same transaction schedules a native rollup crank that ticks once a second. Each tick moves one house bot,
              which sees only its own seat and the public book. The last tick rings the bell. No server runs the game.
            </p>
          </section>
          <section>
            <h2>A Magic Action sends results to Solana</h2>
            <p>
              After the bell, <code>publish_records</code> schedules a Magic Action. It runs on the Solana base layer and
              updates the player record of every seat bound to a wallet. The player makes no commit and pays no fee.
            </p>
          </section>
          <p className="how-foot">
            Program <AddrLink addr={PROGRAM_ID} layer="base">{PROGRAM_ID}</AddrLink> on Solana devnet. Rollup endpoint{" "}
            <code>{TEE_RPC.replace(/^https:\/\//, "")}</code>.
          </p>
        </div>

        <div className="col-side">
          <Diagram />
        </div>
      </div>
    </main>
  );
}

/** One round, top to bottom: who sends transactions, what runs in the rollup, what reaches Solana, and the bell. */
function Diagram() {
  return (
    <figure className="diagram">
      <svg viewBox="0 0 480 552" role="img" aria-labelledby="dg-title dg-desc">
        <title id="dg-title">Outcry architecture</title>
        <desc id="dg-desc">
          Your browser and the house dealer send free transactions to the private ephemeral rollup inside a TEE, where the
          public table, the four sealed seats, VRF and the crank run. Tables are delegated once from Solana; after each bell
          a Magic Action writes player records back to Solana.
        </desc>
        <defs>
          <marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
          </marker>
        </defs>

        {/* who sends transactions */}
        <text x="0" y="22" className="dg-h">Your browser</text>
        <text x="0" y="44">session key, 0 SOL</text>
        <text x="480" y="22" className="dg-h dg-end">House dealer</text>
        <text x="480" y="44" className="dg-end">starts rounds, 0 SOL</text>
        <g className="dg-arrows">
          <path d="M60 58 V102" markerEnd="url(#ah)" />
          <path d="M420 58 V102" markerEnd="url(#ah)" />
        </g>
        <text x="72" y="86">trade</text>
        <text x="408" y="86" className="dg-end">deal</text>

        {/* the rollup */}
        <rect className="dg-rollup" x="1" y="110" width="478" height="268" rx="12" />
        <text x="24" y="146" className="dg-h">Private ephemeral rollup, inside a TEE</text>
        {[0, 1, 2, 3].map((i) => (
          <g key={i} className="dg-seat">
            <circle cx={40 + i * 44} cy="192" r="16" />
            <text x={40 + i * 44} y="197.5">{i + 1}</text>
          </g>
        ))}
        <text x="206" y="188" className="dg-h">Four seats, sealed</text>
        <text x="206" y="208">each read only by its owner</text>
        <path className="dg-rule" d="M24 234 H456" />
        <text x="24" y="264" className="dg-h">Table, public</text>
        <text x="24" y="286">book, tape, scores, clock</text>
        <path className="dg-rule" d="M24 308 H456" />
        <text x="24" y="336" className="dg-h">VRF</text>
        <text x="24" y="358">deals into the seats</text>
        <text x="250" y="336" className="dg-h">Crank</text>
        <text x="250" y="358">bots and bell, once a second</text>

        {/* the base layer */}
        <g className="dg-arrows">
          <path d="M60 430 V388" markerEnd="url(#ah)" />
          <path d="M420 386 V428" markerEnd="url(#ah)" />
        </g>
        <text x="72" y="414">delegate once</text>
        <text x="408" y="414" className="dg-end">Magic Action</text>
        <text x="0" y="456" className="dg-h">Solana devnet</text>
        <text x="0" y="478">program, delegation</text>
        <text x="480" y="456" className="dg-h dg-end">Player records</text>
        <text x="480" y="478" className="dg-end">bound to wallets</text>

        {/* one round on the clock: the same draining bar as the table, red at the bell */}
        <path className="dg-time" d="M0 512 H420" />
        <path className="dg-bell" d="M420 512 H480" />
        <text x="0" y="538">Deal</text>
        <text x="210" y="538" className="dg-mid">Trading, 60 seconds</text>
        <text x="480" y="538" className="dg-h dg-end">Bell</text>
      </svg>
      <figcaption>At the bell all four seats turn public and every hand is revealed.</figcaption>
    </figure>
  );
}

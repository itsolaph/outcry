import { PROGRAM_ID, TEE_RPC } from "./config";
import bellImg from "./assets/img/bell.webp";
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

      <Diagram />

      <div className="how-steps">
        <section className="how-step">
          <h2>The rules</h2>
          <p>
            The deck has four suits of eight cards. You start with eight cards, 200 chips and a secret order such as “4 clubs
            and 2 diamonds”. Post a bid or an offer on any suit, or take someone else’s. When the bell rings, your score is your
            chips, plus 100 if you hold your whole order.
          </p>
        </section>
        <section className="how-step">
          <h2>The trading floor is an Ephemeral Rollup</h2>
          <p>
            Each table and its four seats are delegated once from Solana to a MagicBlock Ephemeral Rollup, and they stay there
            round after round. Every quote, take and bell is a rollup transaction. Nothing waits on Solana blocks and nothing
            costs a fee, so a guest key holding 0 SOL can trade.
          </p>
        </section>
        <section className="how-step">
          <h2>Private rollup permissions hide the hands</h2>
          <p>
            The rollup runs inside a TEE (Intel TDX), and every seat has a permission account. When a round starts, each seat
            turns private with its owner’s key as the only reader. Your browser signs a challenge, gets a token and sees your
            hand. Everyone else sees nothing. Bot seats have no player reader. At the bell all four turn public for the reveal.
          </p>
        </section>
        <section className="how-step">
          <h2>VRF deals the cards</h2>
          <p>
            Starting a round asks MagicBlock’s VRF oracle for randomness. Its callback shuffles the 32 cards, deals eight to
            each seat and draws four secret orders that can all be filled at once. The callback writes straight into the sealed
            seats, and the TEE hides its transaction until the bell makes every hand public.
          </p>
        </section>
        <section className="how-step how-step-bell">
          <h2>A crank moves the bots and rings the bell</h2>
          <p>
            The same transaction schedules a native rollup crank that ticks once a second. Each tick moves one house bot, which
            sees only its own seat and the public book. The last tick rings the bell. No server runs the game.
          </p>
          <img className="how-bell" src={bellImg} alt="A brass hand bell on a wooden trading desk." width={640} height={640} loading="lazy" />
        </section>
        <section className="how-step">
          <h2>A Magic Action sends results to Solana</h2>
          <p>
            After the bell, <code>publish_records</code> schedules a Magic Action. It runs on the Solana base layer and updates
            the player record of every seat bound to a wallet. The player makes no commit and pays no fee.
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

function oct(cx: number, cy: number, a: number, c: number): string {
  return [
    [cx - a + c, cy - a],
    [cx + a - c, cy - a],
    [cx + a, cy - a + c],
    [cx + a, cy + a - c],
    [cx + a - c, cy + a],
    [cx - a + c, cy + a],
    [cx - a, cy + a - c],
    [cx - a, cy - a + c],
  ]
    .map((p) => p.join(","))
    .join(" ");
}

/** The rollup drawn as the pit: sealed seats on the steps, table, VRF and crank on the floor, Solana beside it. */
function Diagram() {
  const cx = 430;
  const cy = 250;
  const seats: [number, number][] = [
    [cx - 118, cy - 118],
    [cx + 118, cy - 118],
    [cx + 118, cy + 118],
    [cx - 118, cy + 118],
  ];
  return (
    <figure className="diagram">
      <svg viewBox="0 0 880 500" role="img" aria-labelledby="dg-title dg-desc">
        <title id="dg-title">Outcry architecture</title>
        <desc id="dg-desc">
          Players' browsers send free transactions to the private ephemeral rollup inside a TEE, drawn as the pit, where the
          table, the four sealed seats, VRF and the crank run. Tables are delegated once from Solana; after each bell a Magic
          Action writes player records back to Solana.
        </desc>
        <defs>
          <marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
          </marker>
        </defs>

        {/* the pit = the private rollup */}
        <text x={cx} y="26" className="dg-title">Private Ephemeral Rollup, inside a TEE</text>
        <polygon className="dg-rail" points={oct(cx, cy, 196, 78)} />
        <polygon className="dg-step0" points={oct(cx, cy, 192, 76)} />
        <polygon className="dg-riser" points={oct(cx, cy, 150, 60)} />
        <polygon className="dg-step1" points={oct(cx, cy, 144, 57)} />
        <polygon className="dg-riser" points={oct(cx, cy, 104, 42)} />
        <polygon className="dg-step2" points={oct(cx, cy, 98, 40)} />

        {seats.map(([x, y], i) => (
          <g key={i} className={`dg-seat dj${i}`}>
            <rect x={x - 42} y={y - 24} width="84" height="48" rx="3" />
            <rect className="dg-plate" x={x - 34} y={y - 17} width="68" height="34" rx="2" />
            <text x={x} y={y - 1} className="dg-h">Seat {i + 1}</text>
            <text x={x} y={y + 13} className="dg-small">sealed</text>
          </g>
        ))}

        <g className="dg-slip">
          <rect x={cx - 66} y={cy - 84} width="132" height="44" rx="3" />
          <text x={cx} y={cy - 64} className="dg-h">VRF</text>
          <text x={cx} y={cy - 48} className="dg-small">deals into seats</text>
        </g>
        <g className="dg-table">
          <rect x={cx - 84} y={cy - 26} width="168" height="52" rx="3" />
          <text x={cx} y={cy - 4} className="dg-h">Table (public)</text>
          <text x={cx} y={cy + 13} className="dg-small">book, tape, scores, clock</text>
        </g>
        <g className="dg-slip">
          <rect x={cx - 66} y={cy + 40} width="132" height="44" rx="3" />
          <text x={cx} y={cy + 60} className="dg-h">Crank</text>
          <text x={cx} y={cy + 76} className="dg-small">bots + bell, 1 Hz</text>
        </g>

        {/* left: who sends transactions */}
        <g className="dg-card">
          <rect x="16" y="96" width="176" height="116" rx="3" />
          <text x="104" y="126" className="dg-h">Your browser</text>
          <text x="104" y="150">session key, 0 SOL</text>
          <text x="104" y="170">TEE token</text>
          <text x="104" y="190">reads only your seat</text>
        </g>
        <g className="dg-card">
          <rect x="16" y="300" width="176" height="80" rx="3" />
          <text x="104" y="332" className="dg-h">House dealer</text>
          <text x="104" y="356">starts rounds, 0 SOL</text>
        </g>

        {/* right: the base layer */}
        <g className="dg-base">
          <rect x="704" y="96" width="160" height="300" rx="3" />
          <text x="784" y="128" className="dg-h">Solana devnet</text>
          <text x="784" y="168">program</text>
          <text x="784" y="194">delegation</text>
          <text x="784" y="296">player records</text>
          <text x="784" y="318">(wallet-bound)</text>
        </g>

        <g className="dg-arrows">
          <path d="M192 154 H246" markerEnd="url(#ah)" />
          <text x="218" y="144" className="dg-small">trade</text>
          <path d="M192 340 H246" markerEnd="url(#ah)" />
          <text x="218" y="330" className="dg-small">deal</text>
          <path d="M704 184 H632" markerEnd="url(#ah)" />
          <text x="668" y="174" className="dg-small">delegate</text>
          <path d="M630 306 H700" markerEnd="url(#ah)" />
          <text x="666" y="292" className="dg-small">Magic</text>
          <text x="666" y="326" className="dg-small">Action</text>
        </g>
        <text x={cx} y="484" className="dg-foot">At the bell the four seat permissions turn public and every hand is revealed.</text>
      </svg>
    </figure>
  );
}

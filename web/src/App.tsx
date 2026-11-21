import { useEffect, useState } from "react";
import { PlayerRecordState } from "@outcry/client";
import { HowItWorks } from "./HowItWorks";
import { Lobby } from "./Lobby";
import { TableView } from "./TableView";
import { initRecord } from "./lib/actions";
import { client, sessionKey } from "./lib/outcry";
import { useSeatKeeper } from "./lib/seatkeeper";
import { connectWallet, disconnectWallet, useWallet, walletPubkey } from "./lib/wallet";
import { AddrLink, Toasts, toast, useHashRoute } from "./ui";

export function App() {
  useSeatKeeper();
  const route = useHashRoute();
  const path = route.split("?")[0];
  const tableMatch = path.match(/^\/t\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
  return (
    <>
      <TopBar route={path} />
      {tableMatch ? <TableView key={tableMatch[1]} address={tableMatch[1]} /> : path === "/how" ? <HowItWorks /> : <Lobby />}
      <footer className="foot">
        <div className="container foot-in">
          <p>Outcry runs on Solana devnet and a MagicBlock private ephemeral rollup. Play money only.</p>
          <a href="#/how">How it works</a>
        </div>
      </footer>
      <Toasts />
    </>
  );
}

function TopBar({ route }: { route: string }) {
  return (
    <header className="topbar">
      <nav className="container topbar-in" aria-label="Main">
        <a className="brand" href="#/">
          Outcry
        </a>
        <a className="nav" href="#/" aria-current={route === "/" ? "page" : undefined}>
          Lobby
        </a>
        <a className="nav" href="#/how" aria-current={route === "/how" ? "page" : undefined}>
          How it works
        </a>
        <span className="grow" />
        <span className="guest" title="Your in-browser session key (holds 0 SOL)">
          Guest key <AddrLink addr={sessionKey().publicKey.toBase58()} layer="er" />
        </span>
        <WalletMenu />
      </nav>
    </header>
  );
}

function WalletMenu() {
  const w = useWallet();
  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<PlayerRecordState | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const addr = w.account?.address ?? null;

  useEffect(() => {
    setRecord(undefined);
    if (!addr) return;
    let alive = true;
    const load = () =>
      client
        .fetchRecord(walletPubkey()!)
        .then((r) => alive && setRecord(r))
        .catch(() => alive && setRecord(null));
    load();
    const id = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [addr]);

  return (
    <div className="wallet">
      <button className="btn btn-line btn-small" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {addr ? (
          `${addr.slice(0, 4)}…${addr.slice(-4)}`
        ) : (
          <>
            Wallet<span className="opt-label"> (optional)</span>
          </>
        )}
      </button>
      {open ? (
        <div className="wallet-pop" role="dialog" aria-label="Wallet">
          {!addr ? (
            <>
              <p>
                A wallet is optional. Connect one (set to devnet) to bind your seat to an on-chain player record. You play the
                same without it.
              </p>
              {w.available.length === 0 ? <p className="muted">No Solana wallet found in this browser.</p> : null}
              {w.available.map((x) => (
                <button
                  key={x.name}
                  className="btn btn-line wallet-opt"
                  onClick={() =>
                    connectWallet(x)
                      .then(() => toast("ok", `${x.name} connected. Your next seat will be bound to it.`))
                      .catch((e) => toast("bad", `Wallet: ${String(e?.message ?? e)}`))
                  }
                >
                  {x.icon ? <img src={x.icon} alt="" width={18} height={18} /> : null} {x.name}
                </button>
              ))}
            </>
          ) : (
            <>
              <p>
                <AddrLink addr={addr} layer="base">{`${addr.slice(0, 6)}…${addr.slice(-6)}`}</AddrLink> on devnet.
              </p>
              {record === undefined ? <p className="muted">Reading your player record…</p> : null}
              {record ? (
                <dl className="record">
                  <dt>Rounds</dt>
                  <dd className="num">{record.rounds}</dd>
                  <dt>Wins</dt>
                  <dd className="num">{record.wins}</dd>
                  <dt>Orders filled</dt>
                  <dd className="num">{record.ordersFilled}</dd>
                  <dt>Best score</dt>
                  <dd className="num">{record.bestScore}</dd>
                </dl>
              ) : null}
              {record === null ? (
                <>
                  <p>No player record yet. Creating one costs about 0.0012 SOL of devnet rent, paid once by your wallet.</p>
                  <button
                    className="btn btn-fill btn-small"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      const r = await initRecord();
                      setBusy(false);
                      if (r.ok) {
                        toast("ok", "Player record created on devnet.");
                        setRecord(await client.fetchRecord(walletPubkey()!));
                      } else toast("bad", `Record not created: ${r.error.short}`);
                    }}
                  >
                    Create my player record
                  </button>
                </>
              ) : null}
              <button className="linkish" onClick={() => disconnectWallet()}>
                Disconnect
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

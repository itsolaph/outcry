// Optional wallet via the Wallet Standard (Phantom, Solflare, Backpack, ...), devnet only.
// Playing never depends on it: a wallet only co-signs `join` to bind the seat to its
// base-layer PlayerRecord, and pays for `init_record` once.
import { useSyncExternalStore } from "react";
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import {
  SolanaSignAndSendTransaction,
  SolanaSignTransaction,
  type SolanaSignAndSendTransactionFeature,
  type SolanaSignTransactionFeature,
} from "@solana/wallet-standard-features";
import { PublicKey, Transaction } from "@solana/web3.js";
import { base } from "./outcry";

const CHAIN = "solana:devnet";

interface WalletState {
  available: Wallet[];
  wallet: Wallet | null;
  account: WalletAccount | null;
}

let state: WalletState = { available: [], wallet: null, account: null };
const listeners = new Set<() => void>();
const emit = (s: Partial<WalletState>) => {
  state = { ...state, ...s };
  listeners.forEach((l) => l());
};

function usable(w: Wallet): boolean {
  return "standard:connect" in w.features && SolanaSignTransaction in w.features && w.chains.some((c) => c.startsWith("solana:"));
}

let started = false;
function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  const { get, on } = getWallets();
  const refresh = () => emit({ available: get().filter(usable) });
  refresh();
  on("register", refresh);
  on("unregister", refresh);
}

export function useWallet(): WalletState {
  start();
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

export async function connectWallet(w: Wallet): Promise<void> {
  const connect = (w.features as any)["standard:connect"].connect as (i?: { silent?: boolean }) => Promise<{ accounts: readonly WalletAccount[] }>;
  const { accounts } = await connect();
  const account = accounts[0] ?? w.accounts[0];
  if (!account) throw new Error("the wallet returned no account");
  emit({ wallet: w, account });
}

export async function disconnectWallet(): Promise<void> {
  const w = state.wallet;
  emit({ wallet: null, account: null });
  const f = (w?.features as any)?.["standard:disconnect"];
  if (f) await f.disconnect().catch(() => {});
}

export function walletPubkey(): PublicKey | null {
  return state.account ? new PublicKey(state.account.address) : null;
}

/** Ask the wallet to sign (not send) a legacy transaction; returns the signed transaction. */
export async function walletSign(tx: Transaction): Promise<Transaction> {
  const { wallet, account } = state;
  if (!wallet || !account) throw new Error("no wallet connected");
  const f = (wallet.features as unknown as SolanaSignTransactionFeature)[SolanaSignTransaction];
  const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  const [out] = await f.signTransaction({ account, transaction: bytes, chain: CHAIN });
  return Transaction.from(out.signedTransaction);
}

/** Sign and send a base-layer (devnet) transaction paid by the wallet. */
export async function walletSendBase(tx: Transaction): Promise<string> {
  const { wallet, account } = state;
  if (!wallet || !account) throw new Error("no wallet connected");
  tx.feePayer = new PublicKey(account.address);
  tx.recentBlockhash = (await base.getLatestBlockhash("confirmed")).blockhash;
  const send = (wallet.features as unknown as Partial<SolanaSignAndSendTransactionFeature>)[SolanaSignAndSendTransaction];
  let sig: string;
  if (send) {
    const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    const [out] = await send.signAndSendTransaction({ account, transaction: bytes, chain: CHAIN });
    const { default: bs58 } = await import("bs58");
    sig = bs58.encode(out.signature);
  } else {
    const signed = await walletSign(tx);
    sig = await base.sendRawTransaction(signed.serialize());
  }
  await base.confirmTransaction(sig, "confirmed");
  return sig;
}

// Single place for deployment settings. Plain data only: the house dealer script imports this
// file from Node as well.

/** Outcry program on Solana devnet. */
export const PROGRAM_ID = "AUnuoAP1BoujRzy4SSPeiJLoiWKPPsHrAcFqcsiSyWVv";

/** Base layer RPC (records, wallet balance). */
export const BASE_RPC = "https://api.devnet.solana.com";

/** MagicBlock Private Ephemeral Rollup (TEE) RPC where the tables live. */
export const TEE_RPC = "https://devnet-tee.magicblock.app";

/** TEE validator the tables are delegated to. */
export const TEE_VALIDATOR = "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";

export const CLUSTER = "devnet";

export interface HouseTable {
  /** Display name in the lobby. */
  name: string;
  /** Table PDA (delegated to the TEE validator). */
  address: string;
}

/** Public house tables kept alive by `scripts/house-dealer.ts`. */
export const HOUSE_TABLES: HouseTable[] = [
  { name: "Pit A", address: "B5DEBWv6haJGznuR3NnQY3KgxHTg9HddGUBGa2qoE9tr" },
  { name: "Pit B", address: "F3rPFZsnfvm63ih7HmPwRuYLiAeeRmdXsZnPGBseX28G" },
  { name: "Pit C", address: "13CtoxNGBp4mRNMLQox1TB79HUvd9gzS5SM49ofLCr9o" },
  { name: "Pit D", address: "H1XjVzo11KLj4r8zZHC5nW2YNyWG2ZKn8CeWNZkWZ4Do" },
];

/** Seconds a newly seated human gets before the house dealer may start a round over them. */
export const HUMAN_GRACE_SECS = 20;

/** Explorer links. The TEE RPC is passed as a custom cluster so ER signatures resolve. */
export function explorerTx(sig: string, layer: "base" | "er"): string {
  if (layer === "base") return `https://explorer.solana.com/tx/${sig}?cluster=${CLUSTER}`;
  return `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent(TEE_RPC)}`;
}

export function explorerAddress(addr: string, layer: "base" | "er"): string {
  if (layer === "base") return `https://explorer.solana.com/address/${addr}?cluster=${CLUSTER}`;
  return `https://explorer.solana.com/address/${addr}?cluster=custom&customUrl=${encodeURIComponent(TEE_RPC)}`;
}

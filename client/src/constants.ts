import { PublicKey } from "@solana/web3.js";
import idlJson from "./idl/outcry.json" with { type: "json" };

/** Program id baked into the bundled IDL (the devnet deployment). */
export const OUTCRY_PROGRAM_ID = new PublicKey((idlJson as { address: string }).address);

export const DEVNET_BASE_RPC = "https://api.devnet.solana.com";
export const DEVNET_TEE_RPC = "https://devnet-tee.magicblock.app";
export const DEVNET_ROUTER_RPC = "https://devnet-router.magicblock.app";
/** TEE validator identity tables are delegated to on devnet. */
export const DEVNET_TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");

export const VRF_PROGRAM_ID = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
/** Delegated VRF queue used from inside an ephemeral rollup (devnet and mainnet). */
export const VRF_EPHEMERAL_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
export const SLOT_HASHES_SYSVAR = new PublicKey("SysvarS1otHashes111111111111111111111111111");

export const TABLE_SEED = Buffer.from("table");
export const SEAT_SEED = Buffer.from("seat");
export const RECORD_SEED = Buffer.from("record");

export const NUM_SEATS = 4;
export const NUM_SUITS = 4;
export const TAPE_LEN = 64;
export const SUITS = ["spades", "clubs", "hearts", "diamonds"] as const;
export type SuitName = (typeof SUITS)[number];

export const SIDE_BID = 0;
export const SIDE_ASK = 1;
export type Side = typeof SIDE_BID | typeof SIDE_ASK;

export const PHASES = ["lobby", "dealing", "trading", "settled"] as const;
export type Phase = (typeof PHASES)[number];

export const SEAT_BOT = 0;
export const SEAT_HUMAN = 1;

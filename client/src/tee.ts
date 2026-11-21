// TEE (Private Ephemeral Rollup) authentication: sign the validator's challenge with the key
// whose reads should be authorized, then put the token on every RPC/WebSocket URL.
import { Commitment, Connection, Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import { DEVNET_TEE_RPC } from "./constants.js";

export type SignMessage = (message: Uint8Array) => Promise<Uint8Array>;

export interface TeeToken {
  token: string;
  expiresAt: number;
  pubkey: PublicKey;
}

export function keypairSigner(kp: Keypair): SignMessage {
  return async (m) => nacl.sign.detached(m, kp.secretKey);
}

/** Authenticate `pubkey` to the TEE RPC (signed challenge). */
export async function getTeeToken(
  pubkey: PublicKey,
  signMessage: SignMessage,
  teeRpc: string = DEVNET_TEE_RPC,
): Promise<TeeToken> {
  const { token, expiresAt } = await getAuthToken(teeRpc.replace(/\/$/, ""), pubkey, signMessage);
  return { token, expiresAt, pubkey };
}

export function teeUrl(teeRpc: string, token?: string): string {
  const base = teeRpc.replace(/\/$/, "");
  return token ? `${base}?token=${token}` : base;
}

/** Connection to the TEE ER whose reads/subscriptions are filtered for the token's owner. */
export function teeConnection(teeRpc: string, token?: string, commitment: Commitment = "confirmed"): Connection {
  const http = teeUrl(teeRpc, token);
  return new Connection(http, { commitment, wsEndpoint: http.replace(/^http/, "ws") });
}

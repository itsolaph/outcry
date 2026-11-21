// App-wide Outcry client, connections and the guest session key.
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { OutcryClient, TeeToken, keypairSigner } from "@outcry/client";
import { BASE_RPC, PROGRAM_ID, TEE_RPC, TEE_VALIDATOR } from "../config";

export const base = new Connection(BASE_RPC, "confirmed");
export const client = new OutcryClient({
  base,
  teeRpc: TEE_RPC,
  validator: new PublicKey(TEE_VALIDATOR),
  programId: new PublicKey(PROGRAM_ID),
});
/** Anonymous ER connection: public tables, and every seat after the bell. */
export const anonEr = client.er();

const SESSION_KEY = "outcry.session.v1";
const TOKEN_KEY = "outcry.token.v1";

/** In-browser session keypair (0 SOL). It is the seat owner; it never holds funds. */
export function sessionKey(): Keypair {
  const raw = localStorage.getItem(SESSION_KEY);
  if (raw) {
    try {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
    } catch {
      // corrupted: replace below
    }
  }
  const kp = Keypair.generate();
  localStorage.setItem(SESSION_KEY, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

export function resetSessionKey(): void {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(TOKEN_KEY);
}

let tokenPromise: Promise<TeeToken> | null = null;
let myErConn: Connection | null = null;

/** TEE auth token for the session key (signed challenge), cached until it expires. */
export async function sessionToken(): Promise<TeeToken> {
  const kp = sessionKey();
  const raw = localStorage.getItem(TOKEN_KEY);
  if (raw) {
    try {
      const t = JSON.parse(raw) as { token: string; expiresAt: number; pubkey: string };
      if (t.pubkey === kp.publicKey.toBase58() && t.expiresAt > Date.now() + 60_000) {
        return { token: t.token, expiresAt: t.expiresAt, pubkey: kp.publicKey };
      }
    } catch {
      // ignore
    }
  }
  if (!tokenPromise) {
    tokenPromise = client
      .auth(kp.publicKey, keypairSigner(kp))
      .then((t) => {
        localStorage.setItem(TOKEN_KEY, JSON.stringify({ token: t.token, expiresAt: t.expiresAt, pubkey: kp.publicKey.toBase58() }));
        return t;
      })
      .finally(() => {
        tokenPromise = null;
      });
  }
  return tokenPromise;
}

/** ER connection authenticated as the session key (reads my private seat; sends). */
export async function myEr(): Promise<Connection> {
  if (myErConn) return myErConn;
  const t = await sessionToken();
  myErConn = client.er(t);
  return myErConn;
}

/** ER clock offset (seconds, ER minus local), refreshed in the background. */
let clockOffset = 0;
let clockAt = 0;
export function erNow(): number {
  if (Date.now() - clockAt > 60_000) {
    clockAt = Date.now();
    client
      .erUnixTime(anonEr)
      .then((t) => {
        clockOffset = t - Date.now() / 1000;
      })
      .catch(() => {});
  }
  return Date.now() / 1000 + clockOffset;
}

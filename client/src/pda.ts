import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { permissionPdaFromAccount } from "@magicblock-labs/ephemeral-rollups-sdk";
import { OUTCRY_PROGRAM_ID, RECORD_SEED, SEAT_SEED, TABLE_SEED } from "./constants.js";

export function tablePda(creator: PublicKey, tableId: bigint | number, programId = OUTCRY_PROGRAM_ID): PublicKey {
  const id = new BN(tableId.toString()).toArrayLike(Buffer, "le", 8);
  return PublicKey.findProgramAddressSync([TABLE_SEED, creator.toBuffer(), id], programId)[0];
}

export function seatPda(table: PublicKey, index: number, programId = OUTCRY_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([SEAT_SEED, table.toBuffer(), Buffer.from([index])], programId)[0];
}

export function seatPdas(table: PublicKey, programId = OUTCRY_PROGRAM_ID): PublicKey[] {
  return [0, 1, 2, 3].map((i) => seatPda(table, i, programId));
}

/** Ephemeral permission PDA that gates reads of a seat on the TEE. */
export function seatPermissionPda(seat: PublicKey): PublicKey {
  return permissionPdaFromAccount(seat);
}

export function recordPda(wallet: PublicKey, programId = OUTCRY_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([RECORD_SEED, wallet.toBuffer()], programId)[0];
}

/** Per-program VRF requester identity (`#[vrf]` macro seed). */
export function vrfProgramIdentity(programId = OUTCRY_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("identity")], programId)[0];
}

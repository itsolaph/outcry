// High-level Outcry client. Base-layer calls (create/delegate/records) go to `base`; table
// play goes to the TEE ER through a token-authenticated connection.
import {
  AccountInfo,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { AnchorProvider, BN, Idl, Program } from "@coral-xyz/anchor";
import {
  DELEGATION_PROGRAM_ID,
  EPHEMERAL_VAULT_ID,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  createTopUpEscrowInstruction,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
  escrowPdaFromEscrowAuthority,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import idlJson from "./idl/outcry.json" with { type: "json" };
import {
  DEVNET_TEE_RPC,
  DEVNET_TEE_VALIDATOR,
  OUTCRY_PROGRAM_ID,
  SLOT_HASHES_SYSVAR,
  Side,
  VRF_EPHEMERAL_QUEUE,
  VRF_PROGRAM_ID,
} from "./constants.js";
import { PlayerRecordState, SeatState, TableState, decodePlayerRecord, decodeSeat, decodeTable } from "./decode.js";
import { recordPda, seatPda, seatPdas, seatPermissionPda, tablePda, vrfProgramIdentity } from "./pda.js";
import { SignMessage, TeeToken, getTeeToken, keypairSigner, teeConnection } from "./tee.js";

export const OUTCRY_IDL = idlJson as unknown as Idl;

export interface OutcryClientOptions {
  base: Connection;
  teeRpc?: string;
  validator?: PublicKey;
  programId?: PublicKey;
}

export interface TableRef {
  table: PublicKey;
  creator: PublicKey;
  tableId: bigint;
}

/** Result of reading a private account through the TEE filter. */
export type PrivateRead<T> = { visible: true; value: T } | { visible: false; reason: string };

export class OutcryClient {
  readonly base: Connection;
  readonly teeRpc: string;
  readonly validator: PublicKey;
  readonly programId: PublicKey;
  /** Instruction builder only (never signs or sends). */
  readonly program: Program;

  constructor(opts: OutcryClientOptions) {
    this.base = opts.base;
    this.teeRpc = (opts.teeRpc ?? DEVNET_TEE_RPC).replace(/\/$/, "");
    this.validator = opts.validator ?? DEVNET_TEE_VALIDATOR;
    this.programId = opts.programId ?? OUTCRY_PROGRAM_ID;
    const idl = { ...(OUTCRY_IDL as any), address: this.programId.toBase58() } as Idl;
    // Anchor's browser build does not export `Wallet` (NodeWallet), so use a plain object. The
    // program is only used to build instructions; this wallet never signs.
    const noSign = async () => {
      throw new Error("OutcryClient.program never signs");
    };
    const wallet = { publicKey: Keypair.generate().publicKey, signTransaction: noSign, signAllTransactions: noSign };
    const dummy = new AnchorProvider(this.base, wallet as any, { commitment: "confirmed" });
    this.program = new Program(idl, dummy);
  }

  // ---------------------------------------------------------------- addresses

  tableRef(creator: PublicKey, tableId: bigint | number): TableRef {
    return { table: tablePda(creator, tableId, this.programId), creator, tableId: BigInt(tableId) };
  }

  seats(table: PublicKey): PublicKey[] {
    return seatPdas(table, this.programId);
  }

  // ---------------------------------------------------------------- TEE auth

  async auth(pubkey: PublicKey, signMessage: SignMessage): Promise<TeeToken> {
    return getTeeToken(pubkey, signMessage, this.teeRpc);
  }

  async authKeypair(kp: Keypair): Promise<TeeToken> {
    return this.auth(kp.publicKey, keypairSigner(kp));
  }

  /** ER connection whose reads are filtered for `token`'s owner (no token = anonymous). */
  er(token?: TeeToken | string): Connection {
    return teeConnection(this.teeRpc, typeof token === "string" ? token : token?.token);
  }

  // ---------------------------------------------------------------- instruction builders

  private seatAccounts(table: PublicKey) {
    const seats = this.seats(table);
    return {
      seat0: seats[0],
      seat1: seats[1],
      seat2: seats[2],
      seat3: seats[3],
      permission0: seatPermissionPda(seats[0]),
      permission1: seatPermissionPda(seats[1]),
      permission2: seatPermissionPda(seats[2]),
      permission3: seatPermissionPda(seats[3]),
      permissionProgram: PERMISSION_PROGRAM_ID,
      ephemeralVault: EPHEMERAL_VAULT_ID,
    };
  }

  async createTableIx(creator: PublicKey, tableId: bigint | number, windowSecs = 90): Promise<TransactionInstruction> {
    const { table } = this.tableRef(creator, tableId);
    const seats = this.seats(table);
    return this.program.methods
      .createTable(new BN(tableId.toString()), windowSecs)
      .accountsPartial({
        creator,
        table,
        seat0: seats[0],
        seat1: seats[1],
        seat2: seats[2],
        seat3: seats[3],
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  async delegateTableIx(creator: PublicKey, tableId: bigint | number): Promise<TransactionInstruction> {
    const { table } = this.tableRef(creator, tableId);
    return this.program.methods
      .delegateTable(new BN(tableId.toString()))
      .accountsPartial({
        creator,
        bufferTable: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(table, this.programId),
        delegationRecordTable: delegationRecordPdaFromDelegatedAccount(table),
        delegationMetadataTable: delegationMetadataPdaFromDelegatedAccount(table),
        table,
        validator: this.validator,
        ownerProgram: this.programId,
        delegationProgram: DELEGATION_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  async delegateSeatIx(creator: PublicKey, tableId: bigint | number, index: number): Promise<TransactionInstruction> {
    const { table } = this.tableRef(creator, tableId);
    const seat = seatPda(table, index, this.programId);
    return this.program.methods
      .delegateSeat(index, new BN(tableId.toString()))
      .accountsPartial({
        creator,
        table,
        bufferSeat: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(seat, this.programId),
        delegationRecordSeat: delegationRecordPdaFromDelegatedAccount(seat),
        delegationMetadataSeat: delegationMetadataPdaFromDelegatedAccount(seat),
        seat,
        validator: this.validator,
        ownerProgram: this.programId,
        delegationProgram: DELEGATION_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  async initPermissionsIx(signer: PublicKey, table: PublicKey): Promise<TransactionInstruction> {
    return this.program.methods
      .initPermissions()
      .accountsPartial({ signer, table, ...this.seatAccounts(table), magicProgram: MAGIC_PROGRAM_ID })
      .instruction();
  }

  async initRecordIx(payer: PublicKey, wallet: PublicKey): Promise<TransactionInstruction> {
    return this.program.methods
      .initRecord()
      .accountsPartial({ payer, wallet, record: recordPda(wallet, this.programId), systemProgram: SystemProgram.programId })
      .instruction();
  }

  async joinIx(signer: PublicKey, table: PublicKey, seatIndex: number, wallet?: PublicKey): Promise<TransactionInstruction> {
    return this.program.methods
      .join(seatIndex)
      // `null` = optional account omitted (Anchor passes the program id in its slot)
      .accountsPartial({ signer, wallet: (wallet ?? null) as any, table })
      .instruction();
  }

  async leaveIx(signer: PublicKey, table: PublicKey, seatIndex: number): Promise<TransactionInstruction> {
    return this.program.methods.leave(seatIndex).accountsPartial({ signer, table }).instruction();
  }

  async setWindowIx(signer: PublicKey, table: PublicKey, windowSecs: number): Promise<TransactionInstruction> {
    return this.program.methods.setWindow(windowSecs).accountsPartial({ signer, table }).instruction();
  }

  async startRoundIx(signer: PublicKey, table: PublicKey, useCrank: boolean): Promise<TransactionInstruction> {
    return this.program.methods
      .startRound(useCrank)
      .accountsPartial({
        signer,
        table,
        ...this.seatAccounts(table),
        magicProgram: MAGIC_PROGRAM_ID,
        oracleQueue: VRF_EPHEMERAL_QUEUE,
        programIdentity: vrfProgramIdentity(this.programId),
        vrfProgram: VRF_PROGRAM_ID,
        slotHashes: SLOT_HASHES_SYSVAR,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  async quoteIx(signer: PublicKey, table: PublicKey, seatIndex: number, suit: number, side: Side, price: number) {
    return this.program.methods
      .quote(seatIndex, suit, side, price)
      .accountsPartial({ signer, table, seat: seatPda(table, seatIndex, this.programId) })
      .instruction();
  }

  async cancelIx(signer: PublicKey, table: PublicKey, seatIndex: number, suit: number, side: Side) {
    return this.program.methods
      .cancel(seatIndex, suit, side)
      .accountsPartial({ signer, table, seat: seatPda(table, seatIndex, this.programId) })
      .instruction();
  }

  async takeIx(signer: PublicKey, table: PublicKey, seatIndex: number, suit: number, side: Side, counterparty: number) {
    return this.program.methods
      .take(seatIndex, suit, side, counterparty)
      .accountsPartial({
        signer,
        table,
        seat: seatPda(table, seatIndex, this.programId),
        counterSeat: seatPda(table, counterparty, this.programId),
      })
      .instruction();
  }

  private settleAccounts(table: PublicKey) {
    return { table, ...this.seatAccounts(table), magicProgram: MAGIC_PROGRAM_ID };
  }

  async ringBellIx(table: PublicKey): Promise<TransactionInstruction> {
    return this.program.methods.ringBell().accountsPartial(this.settleAccounts(table)).instruction();
  }

  async botTickIx(table: PublicKey): Promise<TransactionInstruction> {
    return this.program.methods.botTick().accountsPartial(this.settleAccounts(table)).instruction();
  }

  async publishRecordsIx(payer: PublicKey, table: PublicKey): Promise<TransactionInstruction> {
    return this.program.methods
      .publishRecords()
      .accountsPartial({ payer, table, programId: this.programId, magicProgram: MAGIC_PROGRAM_ID, magicContext: MAGIC_CONTEXT_ID })
      .instruction();
  }

  /** Delegation-program escrow (index 255) the record Magic Action is scheduled under. */
  recordEscrow(table: PublicKey): PublicKey {
    return escrowPdaFromEscrowAuthority(table, 255);
  }

  /**
   * Base: top up the table's action escrow. `record_round` allocates nothing, so this is only
   * needed if a validator requires the escrow to exist/hold lamports before running the action.
   */
  fundRecordEscrowIx(payer: PublicKey, table: PublicKey, lamports: number): TransactionInstruction {
    return createTopUpEscrowInstruction(this.recordEscrow(table), table, payer, lamports, 255);
  }

  async undelegateTableIx(payer: PublicKey, table: PublicKey): Promise<TransactionInstruction> {
    return this.program.methods
      .undelegateTable()
      .accountsPartial({ payer, table, ...this.seatAccounts(table), magicProgram: MAGIC_PROGRAM_ID, magicContext: MAGIC_CONTEXT_ID })
      .instruction();
  }

  // ---------------------------------------------------------------- sending

  /** Send on the base layer (preflight on). */
  async sendBase(ixs: TransactionInstruction[], signers: Keypair[]): Promise<string> {
    return sendAndConfirmTransaction(this.base, new Transaction().add(...ixs), signers, { commitment: "confirmed" });
  }

  /**
   * Send on the TEE ER with `signers[0]` as fee payer (ER fees are zero; a 0-SOL session key
   * works). Preflight stays on; the status is re-checked because on the ER a failed transaction
   * is still recorded.
   */
  async sendEr(conn: Connection, ixs: TransactionInstruction[], signers: Keypair[], computeUnits?: number): Promise<string> {
    const tx = await this.buildErTx(conn, ixs, signers[0].publicKey, computeUnits);
    tx.sign(...signers);
    return this.sendSignedEr(conn, tx.serialize());
  }

  /** Unsigned ER transaction with a fresh ER blockhash (sign it, then `sendSignedEr`). */
  async buildErTx(conn: Connection, ixs: TransactionInstruction[], feePayer: PublicKey, computeUnits?: number): Promise<Transaction> {
    const tx = new Transaction();
    if (computeUnits) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }));
    tx.add(...ixs);
    tx.feePayer = feePayer;
    tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    return tx;
  }

  /** Send an already-signed ER transaction; throws (with simulation logs) if it fails. */
  async sendSignedEr(conn: Connection, raw: Uint8Array | Buffer): Promise<string> {
    const sig = await conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "confirmed" });
    await conn.confirmTransaction(sig, "confirmed");
    const st = await conn.getSignatureStatus(sig);
    if (st.value?.err) throw new Error(`ER transaction ${sig} failed: ${JSON.stringify(st.value.err)}`);
    return sig;
  }

  /** ER clock: unix time of the latest ER slot (falls back to the local clock). */
  async erUnixTime(conn: Connection): Promise<number> {
    try {
      const slot = await conn.getSlot("confirmed");
      const t = await conn.getBlockTime(slot);
      if (t) return t;
    } catch {
      // fall through
    }
    return Math.floor(Date.now() / 1000);
  }

  /** One-time table setup: create + delegate table and seats on base, then seat permissions on the ER. */
  async createAndDelegateTable(creator: Keypair, tableId: bigint | number, windowSecs = 90, creatorEr?: Connection) {
    const ref = this.tableRef(creator.publicKey, tableId);
    const create = await this.sendBase([await this.createTableIx(creator.publicKey, tableId, windowSecs)], [creator]);
    const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 });
    const delegate1 = await this.sendBase(
      [cu, await this.delegateTableIx(creator.publicKey, tableId), await this.delegateSeatIx(creator.publicKey, tableId, 0)],
      [creator],
    );
    const delegate2 = await this.sendBase(
      [
        cu,
        await this.delegateSeatIx(creator.publicKey, tableId, 1),
        await this.delegateSeatIx(creator.publicKey, tableId, 2),
        await this.delegateSeatIx(creator.publicKey, tableId, 3),
      ],
      [creator],
    );
    const er = creatorEr ?? this.er(await this.authKeypair(creator));
    await this.waitForEr(er, ref.table);
    for (const s of this.seats(ref.table)) await this.waitForEr(er, s);
    const perms = await this.sendEr(er, [await this.initPermissionsIx(creator.publicKey, ref.table)], [creator], 600_000);
    return { ...ref, signatures: { create, delegate1, delegate2, perms } };
  }

  /** Wait until the delegated account is visible and owned by the program on the ER. */
  async waitForEr(er: Connection, account: PublicKey, timeoutMs = 60_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      try {
        const info = await er.getAccountInfo(account, "confirmed");
        if (info && info.owner.equals(this.programId)) return;
      } catch {
        // not visible yet / filtered
      }
      if (Date.now() > end) throw new Error(`timeout waiting for ${account.toBase58()} on the ER`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // ---------------------------------------------------------------- reads

  async fetchTable(er: Connection, table: PublicKey): Promise<TableState> {
    const info = await er.getAccountInfo(table, "confirmed");
    if (!info) throw new Error("table not found on the ER");
    return decodeTable(info.data);
  }

  /** Read a seat through the TEE filter; `visible: false` when the token is not a member. */
  async readSeat(er: Connection, table: PublicKey, index: number): Promise<PrivateRead<SeatState>> {
    const seat = seatPda(table, index, this.programId);
    try {
      const info = await er.getAccountInfo(seat, "confirmed");
      if (!info) return { visible: false, reason: "account hidden (null)" };
      return { visible: true, value: decodeSeat(info.data) };
    } catch (e) {
      return { visible: false, reason: String((e as Error).message ?? e) };
    }
  }

  /** My hand + order: use a connection authenticated as the seat owner. */
  async fetchMySeat(myEr: Connection, table: PublicKey, index: number): Promise<SeatState> {
    const r = await this.readSeat(myEr, table, index);
    if (!r.visible) throw new Error(`seat ${index} not readable: ${r.reason}`);
    return r.value;
  }

  /** After the bell every seat permission is public: read all four hands. */
  async fetchRevealedSeats(er: Connection, table: PublicKey): Promise<PrivateRead<SeatState>[]> {
    return Promise.all([0, 1, 2, 3].map((i) => this.readSeat(er, table, i)));
  }

  async fetchRecord(wallet: PublicKey): Promise<PlayerRecordState | null> {
    const info = await this.base.getAccountInfo(recordPda(wallet, this.programId), "confirmed");
    return info ? decodePlayerRecord(info.data) : null;
  }

  /** Subscribe to table changes on the ER (book, tape, phase). Returns an unsubscribe function. */
  subscribeTable(er: Connection, table: PublicKey, onChange: (t: TableState, slot: number) => void): () => Promise<void> {
    const id = er.onAccountChange(
      table,
      (info: AccountInfo<Buffer>, ctx) => {
        try {
          onChange(decodeTable(info.data), ctx.slot);
        } catch {
          // ignore malformed updates
        }
      },
      { commitment: "confirmed" },
    );
    return () => er.removeAccountChangeListener(id);
  }
}

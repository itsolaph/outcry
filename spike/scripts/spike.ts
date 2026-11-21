// Devnet TEE spike. Answers, with real transactions:
//  Q1 private ephemeral permission: member token can read, non-member token cannot
//  Q2 VRF requested inside the TEE ER (ephemeral queue) with a callback into a private account
//  Q3 native crank scheduled inside the TEE ER fires repeatedly (and can flip a permission)
//  Q4 zero-lamport signers can send ER transactions
// Extras: a non-member writing a private account through the program; who can fetch a
// transaction that touches several private accounts; member flags 0 vs full.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nacl from "tweetnacl";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { AnchorProvider, BN, Idl, Program, Wallet } from "@coral-xyz/anchor";
import {
  EPHEMERAL_VAULT_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  getAuthToken,
  permissionPdaFromAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE_RPC = process.env.BASE_RPC ?? "https://api.devnet.solana.com";
const TEE_RPC = process.env.TEE_RPC ?? "https://devnet-tee.magicblock.app";
const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
const EPHEMERAL_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
const FULL_FLAGS = 2 | 4 | 8; // TX_LOGS | TX_BALANCES | TX_MESSAGE

const idl = JSON.parse(fs.readFileSync(path.join(here, "../../target/idl/probe.json"), "utf8")) as Idl;
const PROGRAM_ID = new PublicKey((idl as any).address);

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}
const deployer = loadKeypair(
  process.env.DEPLOYER ?? path.join(os.homedir(), ".config/solana/outcry-devnet/deployer.json"),
);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(...a);
const errMsg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);

async function token(kp: Keypair): Promise<string> {
  const { token } = await getAuthToken(TEE_RPC, kp.publicKey, async (m) => nacl.sign.detached(m, kp.secretKey));
  return token;
}

async function sendEr(conn: Connection, ixs: TransactionInstruction[], signers: Keypair[]) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction(sig, "confirmed");
  const st = await conn.getSignatureStatus(sig);
  if (st.value?.err) throw new Error(`ER tx ${sig} failed: ${JSON.stringify(st.value.err)}`);
  return sig;
}

/** Try with the 0-SOL key first, then the funded deployer, so a Q4 failure is not misread. */
async function sendErWithFallback(
  label: string,
  conn: Connection,
  connDeployer: Connection,
  build: (signer: PublicKey) => Promise<TransactionInstruction>,
  zeroSol: Keypair,
  results: Record<string, unknown>,
) {
  try {
    const sig = await sendEr(conn, [await build(zeroSol.publicKey)], [zeroSol]);
    results[label] = { signer: "0-SOL key", sig };
    log(`${label}: ok (0-SOL signer) ${sig}`);
    return sig;
  } catch (e) {
    log(`${label}: 0-SOL signer failed: ${errMsg(e)}`);
    const sig = await sendEr(connDeployer, [await build(deployer.publicKey)], [deployer]);
    results[label] = { signer: "deployer", sig, zeroSolError: errMsg(e) };
    log(`${label}: ok (deployer) ${sig}`);
    return sig;
  }
}

async function main() {
  const results: Record<string, unknown> = {};
  const base = new Connection(BASE_RPC, "confirmed");
  const provider = new AnchorProvider(base, new Wallet(deployer), { commitment: "confirmed" });
  const program = new Program(idl, provider);
  const M = Keypair.generate(); // member, 0 SOL
  const O = Keypair.generate(); // outsider, 0 SOL
  log("program", PROGRAM_ID.toBase58());
  log("member M (0 SOL)", M.publicKey.toBase58());
  log("outsider O (0 SOL)", O.publicKey.toBase58());

  const idBase = Date.now();
  const probes: Record<string, { id: BN; pda: PublicKey; perm: PublicKey }> = {};
  for (const [name, off] of [["A", 0], ["B", 1], ["D", 2]] as const) {
    const id = new BN(idBase + off);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("probe"), deployer.publicKey.toBuffer(), id.toArrayLike(Buffer, "le", 8)],
      PROGRAM_ID,
    );
    probes[name] = { id, pda, perm: permissionPdaFromAccount(pda) };
  }
  log("probes", Object.fromEntries(Object.entries(probes).map(([k, v]) => [k, v.pda.toBase58()])));

  // Base: init + delegate all three probes to the TEE validator.
  const baseTx = new Transaction();
  for (const p of Object.values(probes)) {
    baseTx.add(await program.methods.init(p.id).accountsPartial({ authority: deployer.publicKey, probe: p.pda }).instruction());
    baseTx.add(
      await program.methods
        .delegateProbe(p.id)
        .accountsPartial({ authority: deployer.publicKey, probe: p.pda, validator: TEE_VALIDATOR })
        .instruction(),
    );
  }
  const baseSig = await sendAndConfirmTransaction(base, baseTx, [deployer]);
  log("base init+delegate x3:", baseSig);
  results.baseInitDelegate = baseSig;

  const tokM = await token(M);
  const tokO = await token(O);
  const tokDep = await token(deployer);
  const erM = new Connection(`${TEE_RPC}?token=${tokM}`, "confirmed");
  const erO = new Connection(`${TEE_RPC}?token=${tokO}`, "confirmed");
  const erDep = new Connection(`${TEE_RPC}?token=${tokDep}`, "confirmed");
  const erAnon = new Connection(TEE_RPC, "confirmed");

  const decode = (data: Buffer) => program.coder.accounts.decode("probe", data);
  async function read(conn: Connection, pda: PublicKey) {
    try {
      const info = await conn.getAccountInfo(pda, "confirmed");
      if (!info) return { visible: false, why: "null" } as const;
      return { visible: true, owner: info.owner.toBase58(), data: decode(info.data) } as const;
    } catch (e) {
      return { visible: false, why: errMsg(e) } as const;
    }
  }

  for (let i = 0; i < 60; i++) {
    const r = await Promise.all(Object.values(probes).map((p) => read(erDep, p.pda)));
    if (r.every((x) => x.visible && (x as any).owner === PROGRAM_ID.toBase58())) break;
    await sleep(1000);
  }
  log("delegated probes visible on TEE ER");

  const permAccounts = (signer: PublicKey, p: { pda: PublicKey; perm: PublicKey }) => ({
    signer,
    probe: p.pda,
    permission: p.perm,
    permissionProgram: PERMISSION_PROGRAM_ID,
    ephemeralVault: EPHEMERAL_VAULT_ID,
    magicProgram: MAGIC_PROGRAM_ID,
  });

  // Permissions: A -> M full flags (0-SOL signer test = Q4), B -> O full flags, D -> M flags 0.
  await sendErWithFallback(
    "Q4_createPermissionA",
    erM,
    erDep,
    (s) => program.methods.createPermission(M.publicKey, FULL_FLAGS).accountsPartial(permAccounts(s, probes.A)).instruction(),
    M,
    results,
  );
  await sendEr(erDep, [await program.methods.createPermission(O.publicKey, FULL_FLAGS).accountsPartial(permAccounts(deployer.publicKey, probes.B)).instruction()], [deployer]);
  await sendEr(erDep, [await program.methods.createPermission(M.publicKey, 0).accountsPartial(permAccounts(deployer.publicKey, probes.D)).instruction()], [deployer]);
  await sleep(1500);

  // Q1 reads.
  const q1 = {
    A_byMember: (await read(erM, probes.A.pda)).visible,
    A_byOutsider: await read(erO, probes.A.pda),
    A_noToken: await read(erAnon, probes.A.pda),
    A_byDeployer: (await read(erDep, probes.A.pda)).visible,
    D_byMemberFlags0: (await read(erM, probes.D.pda)).visible,
  };
  log("Q1", JSON.stringify(q1));
  results.q1 = q1;

  // Non-member (0 SOL) writes A through the program.
  try {
    const sig = await sendEr(erO, [await program.methods.poke().accountsPartial({ signer: O.publicKey, probe: probes.A.pda }).instruction()], [O]);
    const after = await read(erM, probes.A.pda);
    results.nonMemberWrite = { ok: true, sig, pokesSeenByMember: after.visible ? (after as any).data.pokes.toString() : "?" };
    log("non-member poke of A ok", sig);
  } catch (e) {
    results.nonMemberWrite = { ok: false, err: errMsg(e) };
    log("non-member poke failed", errMsg(e));
  }

  // Multi-account tx visibility: deployer pokes A (M) and B (O) together.
  async function txView(conn: Connection, sig: string) {
    try {
      const t = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
      if (!t) return "null";
      return `visible(keys=${t.transaction.message.staticAccountKeys.length},logs=${t.meta?.logMessages?.length ?? 0})`;
    } catch (e) {
      return `error:${errMsg(e).slice(0, 100)}`;
    }
  }
  try {
    const sig = await sendEr(erDep, [await program.methods.pokePair().accountsPartial({ signer: deployer.publicKey, probeA: probes.A.pda, probeB: probes.B.pda }).instruction()], [deployer]);
    await sleep(1500);
    const v = { sig, member_of_A: await txView(erM, sig), member_of_B: await txView(erO, sig), noToken: await txView(erAnon, sig), sender: await txView(erDep, sig) };
    log("pair tx visibility", JSON.stringify(v));
    results.pairTxVisibility = v;
    const sigD = await sendEr(erDep, [await program.methods.poke().accountsPartial({ signer: deployer.publicKey, probe: probes.D.pda }).instruction()], [deployer]);
    await sleep(1500);
    const vD = { sig: sigD, memberFlags0: await txView(erM, sigD), outsider: await txView(erO, sigD) };
    log("flags-0 tx visibility", JSON.stringify(vD));
    results.flags0TxVisibility = vD;
  } catch (e) {
    log("visibility test failed", errMsg(e));
    results.pairTxVisibility = { err: errMsg(e) };
  }

  // Q2: VRF inside the TEE ER into private A.
  try {
    const reqSig = await sendErWithFallback(
      "Q2_requestVrf",
      erM,
      erDep,
      (s) => program.methods.requestVrf(7).accountsPartial({ payer: s, probe: probes.A.pda, oracleQueue: EPHEMERAL_QUEUE }).instruction(),
      M,
      results,
    );
    let fulfilled = false;
    let rnd = "";
    for (let i = 0; i < 45; i++) {
      const r = await read(erM, probes.A.pda);
      if (r.visible && Number((r as any).data.vrfFulfilled) > 0) {
        fulfilled = true;
        rnd = Buffer.from((r as any).data.randomness).toString("hex");
        break;
      }
      await sleep(1000);
    }
    let callbackSig: string | undefined;
    const sigs = await erM.getSignaturesForAddress(probes.A.pda, { limit: 25 }).catch(() => []);
    for (const s of sigs) {
      const t = await erM.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null);
      if (t?.meta?.logMessages?.some((l) => l.includes("CallbackVrf"))) {
        callbackSig = s.signature;
        break;
      }
    }
    const q2 = {
      requestSig: reqSig,
      fulfilled,
      randomness: rnd,
      callbackSig,
      callbackSeenByMember: callbackSig ? await txView(erM, callbackSig) : "n/a",
      callbackSeenByOutsider: callbackSig ? await txView(erO, callbackSig) : "n/a",
    };
    log("Q2", JSON.stringify(q2));
    results.q2 = q2;
  } catch (e) {
    log("Q2 failed", errMsg(e));
    results.q2 = { err: errMsg(e) };
  }

  // Q3: crank. A gets 20 x 500 ms plain ticks; B gets a no-signer tick that flips it public.
  try {
    const taskA = new BN(Math.floor(Math.random() * 2 ** 40) + 1_000_000);
    await sendErWithFallback(
      "Q3_scheduleTicks",
      erM,
      erDep,
      (s) => program.methods.scheduleTicks(taskA, new BN(500), new BN(20)).accountsPartial({ payer: s, probe: probes.A.pda, magicProgram: MAGIC_PROGRAM_ID }).instruction(),
      M,
      results,
    );
    const taskB = new BN(Math.floor(Math.random() * 2 ** 40) + 1_000_000);
    await sendErWithFallback(
      "Q3_scheduleReveal",
      erM,
      erDep,
      (s) =>
        program.methods
          .scheduleReveal(taskB, new BN(700), new BN(6))
          .accountsPartial({
            payer: s,
            probe: probes.B.pda,
            permission: probes.B.perm,
            permissionProgram: PERMISSION_PROGRAM_ID,
            ephemeralVault: EPHEMERAL_VAULT_ID,
            magicProgram: MAGIC_PROGRAM_ID,
          })
          .instruction(),
      M,
      results,
    );
    const samples: number[] = [];
    for (let i = 0; i < 14; i++) {
      await sleep(1000);
      const r = await read(erM, probes.A.pda);
      samples.push(r.visible ? Number((r as any).data.ticks) : -1);
    }
    const bAfter = await read(erM, probes.B.pda); // M is not a member of B
    const tickSigs = await erM.getSignaturesForAddress(probes.A.pda, { limit: 3 }).catch(() => []);
    const q3 = {
      tickSamples: samples,
      recentTickSigs: tickSigs.map((s) => s.signature),
      crankRevealMadeBVisibleToNonMember: bAfter.visible,
      bTicks: bAfter.visible ? Number((bAfter as any).data.ticks) : null,
    };
    log("Q3", JSON.stringify(q3));
    results.q3 = q3;
  } catch (e) {
    log("Q3 failed", errMsg(e));
    results.q3 = { err: errMsg(e) };
  }

  // Reveal A via instruction; outsider reads.
  try {
    const sig = await sendEr(erDep, [await program.methods.setPublic().accountsPartial(permAccounts(deployer.publicKey, probes.A)).instruction()], [deployer]);
    await sleep(1500);
    const r = await read(erO, probes.A.pda);
    results.revealA = { sig, outsiderVisibleAfter: r.visible };
    log("reveal A", sig, "outsider sees A:", r.visible);
  } catch (e) {
    results.revealA = { err: errMsg(e) };
  }

  log("\nRESULTS", JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(here, "spike-results.json"), JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

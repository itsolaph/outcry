// Offline smoke test of @outcry/client: builds every instruction without sending anything.
import { Connection, Keypair } from "@solana/web3.js";
import { OutcryClient, SIDE_ASK, SIDE_BID, decodeTable, TABLE_ACCOUNT_SIZE } from "../client/src/index.js";

const c = new OutcryClient({ base: new Connection("http://127.0.0.1:8899") });
const k = Keypair.generate();
const { table } = c.tableRef(k.publicKey, 1n);
const ixs = {
  createTable: await c.createTableIx(k.publicKey, 1n),
  delegateTable: await c.delegateTableIx(k.publicKey, 1n),
  delegateSeat: await c.delegateSeatIx(k.publicKey, 1n, 2),
  initPermissions: await c.initPermissionsIx(k.publicKey, table),
  initRecord: await c.initRecordIx(k.publicKey, k.publicKey),
  joinWithWallet: await c.joinIx(k.publicKey, table, 0, k.publicKey),
  joinAnon: await c.joinIx(k.publicKey, table, 1),
  leave: await c.leaveIx(k.publicKey, table, 0),
  setWindow: await c.setWindowIx(k.publicKey, table, 60),
  startRound: await c.startRoundIx(k.publicKey, table, true),
  quote: await c.quoteIx(k.publicKey, table, 0, 1, SIDE_BID, 20),
  cancel: await c.cancelIx(k.publicKey, table, 0, 1, SIDE_BID),
  take: await c.takeIx(k.publicKey, table, 0, 1, SIDE_ASK, 2),
  ringBell: await c.ringBellIx(table),
  botTick: await c.botTickIx(table),
  publishRecords: await c.publishRecordsIx(k.publicKey, table),
  undelegateTable: await c.undelegateTableIx(k.publicKey, table),
};
for (const [name, ix] of Object.entries(ixs)) {
  console.log(name.padEnd(16), "accounts", String(ix.keys.length).padStart(2), "data", ix.data.length);
}
const t = decodeTable(Buffer.alloc(TABLE_ACCOUNT_SIZE));
console.log("decodeTable ok:", t.phase, t.seats.length, t.tape.length);

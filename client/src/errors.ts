// Turn a failed send (preflight simulation or on-ER failure) into the program error that caused
// it. web3.js puts the simulation logs on `SendTransactionError.logs`; the message itself often
// says only "Simulation failed".
import idlJson from "./idl/outcry.json" with { type: "json" };

export interface OutcryErrorInfo {
  /** Anchor error code (6000+ for Outcry, 2000+ for Anchor constraints), if one was found. */
  code?: number;
  /** IDL / Anchor error name, e.g. `NoQuote`. */
  name?: string;
  /** Short player-facing text, e.g. "book moved". */
  short: string;
  /** Longer explanation for logs and tooltips. */
  detail: string;
  logs: string[];
}

const IDL_ERRORS = new Map<number, { name: string; msg: string }>(
  ((idlJson as any).errors as { code: number; name: string; msg: string }[]).map((e) => [e.code, { name: e.name, msg: e.msg }]),
);

/** Player-facing wording for the errors a player can actually hit. */
const SHORT: Record<string, string> = {
  NoQuote: "book moved",
  NoCard: "no card",
  NoChips: "no chips",
  TradingClosed: "trading closed",
  SelfCross: "would cross your own quote",
  SelfTrade: "that is your own quote",
  RoundInProgress: "round in progress",
  SeatTaken: "seat taken",
  AlreadySeated: "already seated here",
  NotSeatOwner: "not your seat",
  NotAllowed: "not allowed",
  BellTooEarly: "bell not due yet",
  AlreadyPublished: "records already published",
  BadPrice: "price must be 1-99",
};

function collectLogs(e: any): string[] {
  const out: string[] = [];
  for (const k of ["logs", "transactionLogs"]) {
    const v = e?.[k];
    if (Array.isArray(v)) out.push(...v.map(String));
  }
  const nested = e?.transactionError ?? e?.cause;
  if (nested && nested !== e) out.push(...collectLogs(nested));
  return out;
}

export function explainError(e: unknown): OutcryErrorInfo {
  const err = e as any;
  const message = String(err?.message ?? err ?? "");
  const logs = collectLogs(err);
  const hay = [message, ...logs].join("\n");
  let code: number | undefined;
  const anchor = hay.match(/Error Number: (\d+)/);
  if (anchor) code = Number(anchor[1]);
  if (code === undefined) {
    const hex = hay.match(/custom program error: 0x([0-9a-fA-F]+)/);
    if (hex) code = parseInt(hex[1], 16);
  }
  if (code === undefined) {
    const custom = hay.match(/"Custom":\s*(\d+)/);
    if (custom) code = Number(custom[1]);
  }
  if (code !== undefined) {
    const idl = IDL_ERRORS.get(code);
    if (idl) return { code, name: idl.name, short: SHORT[idl.name] ?? idl.msg, detail: idl.msg, logs };
    const anchorName = hay.match(/Error Code: (\w+)/)?.[1];
    if (code === 2040 || anchorName === "ConstraintDuplicateMutableAccount") {
      return { code, name: anchorName, short: "that is your own quote", detail: "duplicate mutable account", logs };
    }
    return { code, name: anchorName, short: anchorName ?? `error ${code}`, detail: message.split("\n")[0], logs };
  }
  if (/blockhash not found|block height exceeded/i.test(hay)) {
    return { short: "network busy, try again", detail: message.split("\n")[0], logs };
  }
  if (/failed to fetch|network|timeout|timed out/i.test(hay)) {
    return { short: "network error", detail: message.split("\n")[0], logs };
  }
  return { short: message.split("\n")[0].slice(0, 80) || "transaction failed", detail: message, logs };
}

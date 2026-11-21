// End-to-end check of the built web client against real devnet (TEE rollup):
// serve web/dist, open the lobby in headless Chromium, "Play now" as a guest, check the private
// hand renders, trade against the house bots, wait for the bell, check the reveal and the
// scoreboard, then leave the seat. Screenshots go to docs/screenshots/.
//
//   npm run build -w web && npx tsx scripts/e2e-web.ts [--headed]
//
// The guest key is a stored devnet throwaway (~/.config/solana/outcry-devnet/e2e-guest.json,
// generated on first run, never funded) injected into localStorage, so a failed run never
// strands a seat: the script frees any seat the key still holds before and after the run.
// Chromium is installed on first run into .playwright-browsers/ (gitignored).
import { spawn, spawnSync, ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { OutcryClient, seatOf } from "../client/src/index.js";
import { BASE_RPC, HOUSE_TABLES, PROGRAM_ID, TEE_RPC } from "../web/src/config.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(ROOT, ".playwright-browsers");
const SHOTS = path.join(ROOT, "docs/screenshots");
const PORT = 4173;
const URL_BASE = `http://127.0.0.1:${PORT}/`;
const KEY = path.join(os.homedir(), ".config/solana/outcry-devnet/e2e-guest.json");
const WALLET_KEY = path.join(os.homedir(), ".config/solana/outcry-devnet/e2e-wallet.json");
const HEADED = process.argv.includes("--headed");

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function storedKey(file: string, create = true): Keypair {
  if (fs.existsSync(file)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
  if (!create) throw new Error(`missing key ${path.basename(file)}`);
  const kp = Keypair.generate();
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return kp;
}
const guestKey = () => storedKey(KEY);

async function freeSeats(client: OutcryClient, guest: Keypair): Promise<void> {
  const er = client.er(await client.authKeypair(guest));
  for (const h of HOUSE_TABLES) {
    const table = new PublicKey(h.address);
    const t = await client.fetchTable(er, table).catch(() => null);
    const i = t ? seatOf(t, guest.publicKey.toBase58()) : -1;
    if (i >= 0) {
      const sig = await client.sendEr(er, [await client.leaveIx(guest.publicKey, table, i)], [guest]);
      log(`freed leftover seat ${i} at ${h.name}: ${sig}`);
    }
  }
}

async function ensureChromium() {
  const pw = await import("playwright-core");
  try {
    const b = await pw.chromium.launch({ headless: true });
    await b.close();
    return;
  } catch {
    // not installed yet
  }
  log("installing Chromium headless shell into .playwright-browsers/ ...");
  const r = spawnSync(process.execPath, [path.join(ROOT, "node_modules/playwright-core/cli.js"), "install", "chromium-headless-shell"], {
    stdio: "inherit",
    env: process.env,
  });
  if (r.status !== 0) throw new Error("playwright browser install failed");
}

function startPreview(): ChildProcess {
  const vite = path.join(ROOT, "node_modules/vite/bin/vite.js");
  const p = spawn(process.execPath, [vite, "preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
    cwd: path.join(ROOT, "web"),
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout?.on("data", () => {});
  p.stderr?.on("data", (d) => process.stderr.write(`[preview] ${d}`));
  return p;
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(URL_BASE);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  throw new Error("preview server did not start");
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, "web/dist/index.html"))) throw new Error("build first: npm run build -w web");
  fs.mkdirSync(SHOTS, { recursive: true });
  const guest = guestKey();
  const walletKp = storedKey(WALLET_KEY);
  const client = new OutcryClient({ base: new Connection(BASE_RPC, "confirmed"), teeRpc: TEE_RPC, programId: new PublicKey(PROGRAM_ID) });
  log("guest (0 SOL)", guest.publicKey.toBase58());
  await freeSeats(client, guest);
  // The mock wallet holds 0 SOL, so the deployer pays its one-time PlayerRecord (base, ~0.0012 SOL).
  // Without a deployer key the run still checks the wallet binding but skips the record check.
  let checkRecord = true;
  if (!(await client.fetchRecord(walletKp.publicKey))) {
    const deployerPath = path.join(os.homedir(), ".config/solana/outcry-devnet/deployer.json");
    if (fs.existsSync(deployerPath)) {
      const deployer = storedKey(deployerPath, false);
      const sig = await client.sendBase([await client.initRecordIx(deployer.publicKey, walletKp.publicKey)], [deployer]);
      log("init_record for the e2e wallet (deployer pays):", sig);
    } else {
      checkRecord = false;
      log("no deployer key: the e2e wallet has no PlayerRecord, so the record check is skipped");
    }
  }

  await ensureChromium();
  const { chromium } = await import("playwright-core");
  const server = startPreview();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  const errors: string[] = [];
  try {
    await waitForServer();
    log("serving web/dist at", URL_BASE);
    browser = await chromium.launch({ headless: !HEADED });
    const ctx = await browser.newContext({ viewport: { width: 1320, height: 900 }, deviceScaleFactor: 1, timezoneId: "UTC", locale: "en-US" });
    await ctx.addInitScript((secret: number[]) => {
      try {
        if (!localStorage.getItem("outcry.session.v1")) localStorage.setItem("outcry.session.v1", JSON.stringify(secret));
      } catch {
        // about:blank has no localStorage
      }
    }, Array.from(guest.secretKey));
    // A mock Wallet Standard wallet (registered, not connected until part 2). It signs in Node with
    // a stored devnet key, standing in for a browser extension such as Phantom.
    await ctx.exposeFunction("__e2eWalletSign", (bytes: number[]) => {
      const tx = Transaction.from(Buffer.from(bytes));
      tx.partialSign(walletKp);
      return Array.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
    });
    // Passed as a string: tsx/esbuild would wrap a function argument in `__name(...)` helpers that
    // do not exist in the page.
    await ctx.addInitScript(`(() => {
      const account = {
        address: ${JSON.stringify(walletKp.publicKey.toBase58())},
        publicKey: new Uint8Array(${JSON.stringify(Array.from(walletKp.publicKey.toBytes()))}),
        chains: ["solana:devnet"],
        features: ["solana:signTransaction"],
      };
      const wallet = {
        version: "1.0.0",
        name: "E2E Test Wallet",
        icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHZpZXdCb3g9JzAgMCAxIDEnLz4=",
        chains: ["solana:devnet"],
        accounts: [account],
        features: {
          "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) },
          "standard:events": { version: "1.0.0", on: () => () => {} },
          "solana:signTransaction": {
            version: "1.0.0",
            supportedTransactionVersions: ["legacy", 0],
            signTransaction: async (...inputs) =>
              Promise.all(inputs.map(async (i) => ({ signedTransaction: new Uint8Array(await window.__e2eWalletSign(Array.from(i.transaction))) }))),
          },
        },
      };
      const register = (api) => api.register(wallet);
      window.addEventListener("wallet-standard:app-ready", (e) => register(e.detail));
      window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: register }));
    })();`);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 200)}`);
      if (m.type() === "warning" && m.text().includes("[outcry]")) log("app warning:", m.text().slice(0, 240));
    });

    // ---- lobby
    await page.goto(URL_BASE);
    await page.getByTestId("lobby-table").first().waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll("[data-testid=lobby-table] .status")].every((e) => !/Loading/.test(e.textContent ?? "")), null, { timeout: 30_000 });
    const rows = await page.getByTestId("lobby-table").allInnerTexts();
    log(`lobby shows ${rows.length} house tables:`);
    rows.forEach((r) => log("   ", r.replace(/\s+/g, " ").trim()));
    await page.screenshot({ path: path.join(SHOTS, "lobby.png") });

    // ---- play now
    await page.getByTestId("play-now").click();
    await page.waitForURL(/#\/t\//);
    const tableAddr = page.url().split("#/t/")[1].split("?")[0];
    const house = HOUSE_TABLES.find((h) => h.address === tableAddr);
    log(`Play now -> ${house?.name} (${tableAddr})`);

    // seated + dealt: the hand renders from my private seat (may first wait for the bell)
    await page.getByTestId("my-hand").waitFor({ timeout: 150_000 });
    const order = await page.getByTestId("my-order").innerText();
    const hand = await page.getByTestId("my-hand").innerText();
    const chips = await page.getByTestId("my-chips").innerText();
    log(`hand rendered: order "${order.replace(/\s+/g, " ")}", hand "${hand.replace(/\s+/g, " ")}", chips ${chips}`);
    await sleep(1500);
    await page.screenshot({ path: path.join(SHOTS, "table-trading.png") });

    // ---- trade: one quote (offer a card I hold), then try to take a bot's quote
    let okCount = 0;
    // Wait for the toast produced by this action (newer than any toast shown before it).
    const lastToastId = () =>
      page.evaluate(() => Math.max(0, ...[...document.querySelectorAll("[data-toast-id]")].map((e) => Number(e.getAttribute("data-toast-id")))));
    const waitToast = async (after: number) => {
      const h = await page
        .waitForFunction(
          (n) => {
            const el = [...document.querySelectorAll("[data-toast-id]")].find((e) => Number(e.getAttribute("data-toast-id")) > n);
            return el ? `${el.getAttribute("data-testid") === "toast-ok" ? "ok" : "rejected"}: ${el.textContent}` : null;
          },
          after,
          { timeout: 25_000 },
        )
        .catch(() => null);
      return h ? String(await h.jsonValue()) : "no response";
    };
    const wants = async (s: number) => /row-want/.test((await page.getByTestId(`book-row-${s}`).getAttribute("class")) ?? "");

    // quote: offer a spare card (a suit my order does not still need)
    for (let s = 0; s < 4 && okCount === 0; s++) {
      const offer = page.getByTestId(`offer-${s}`);
      if ((await wants(s)) || !(await offer.isEnabled())) continue;
      await page.getByTestId(`px-${s}`).fill("45");
      const before = await lastToastId();
      await offer.click();
      const r = await waitToast(before);
      log(`quote: offer 45 on suit ${s} -> ${r.replace(/\s+/g, " ")}`);
      if (r.startsWith("ok")) okCount++;
      await page.waitForTimeout(800);
    }
    // take: buy a suit I still need from a bot, or sell a spare into a bot's bid
    let took = false;
    for (let attempt = 0; attempt < 15 && !took; attempt++) {
      for (let s = 0; s < 4 && !took; s++) {
        const kind = (await wants(s)) ? "buy" : "sell";
        const b = page.getByTestId(`${kind}-${s}`);
        if (!(await b.isEnabled().catch(() => false))) continue;
        const px = (await b.innerText()).replace(/\s+/g, " ");
        const before = await lastToastId();
        await b.click();
        const r = await waitToast(before);
        log(`take: ${px} on suit ${s} -> ${r.replace(/\s+/g, " ")}`);
        if (r.startsWith("ok")) {
          okCount++;
          took = true;
        }
        await page.waitForTimeout(800);
      }
      if (!took) await page.waitForTimeout(2500);
      const phase = await page.locator("main").getAttribute("data-phase");
      if (phase !== "trading") break;
    }
    log(`trading: ${okCount} accepted actions (take ${took ? "filled" : "not filled"})`);
    if (okCount === 0) throw new Error("no quote or take was accepted");
    await page.screenshot({ path: path.join(SHOTS, "table-after-trade.png") });
    if ((await page.locator("main").getAttribute("data-phase")) === "trading") {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(() => !document.querySelector(".toast"), null, { timeout: 8000 }).catch(() => {});
      await sleep(400);
      await page.screenshot({ path: path.join(SHOTS, "table-trading-phone.png"), fullPage: true });
      await page.setViewportSize({ width: 1320, height: 900 });
    }

    // ---- the bell and the reveal
    log("waiting for the bell ...");
    await page.getByTestId("reveal").waitFor({ timeout: 150_000 });
    await page.waitForFunction(() => document.querySelectorAll("[data-testid=scoreboard] li").length === 4, null, { timeout: 20_000 });
    await page.waitForFunction(() => document.querySelectorAll(".card-flip.is-open").length === 4, null, { timeout: 30_000 });
    const board = await page.getByTestId("scoreboard").innerText();
    log("scoreboard:");
    board
      .split("\n")
      .filter(Boolean)
      .join(" ")
      .split(/(?=\b[1-4] (?:Red|Green|Gold|Blue)\b)/)
      .forEach((l) => log("   ", l.trim()));
    const published = await page
      .waitForFunction(() => !document.querySelector(".story")?.textContent?.includes("(pending)"), null, { timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    log(`records published for the round: ${published ? "yes" : "not within 20 s"}`);
    await page.waitForFunction(() => [...document.querySelectorAll(".story a")].some((a) => /bell transaction/.test(a.textContent ?? "")), null, { timeout: 20_000 }).catch(() => {});
    for (const a of await page.locator(".story a").all()) {
      const href = (await a.getAttribute("href")) ?? "";
      const sig = href.match(/\/(?:tx|address)\/([1-9A-HJ-NP-Za-km-z]+)/)?.[1];
      log(`explainer link "${(await a.innerText()).trim()}": ${sig}`);
    }
    await sleep(1200);
    await page.screenshot({ path: path.join(SHOTS, "reveal.png"), fullPage: true });

    // ---- phone layout of the reveal and the explainer page
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(500);
    await page.screenshot({ path: path.join(SHOTS, "reveal-phone.png") });
    const txlog = await page.evaluate(() => localStorage.getItem("outcry.txlog.v1"));
    for (const e of JSON.parse(txlog ?? "[]").reverse()) log(`tx (${e.layer}) ${e.label}: ${e.sig}`);

    // ---- leave
    await page.setViewportSize({ width: 1320, height: 900 });
    await page.getByTestId("leave").click();
    await page.waitForURL((u) => !u.hash.includes("/t/"), { timeout: 30_000 });
    log("left the table");
    await page.goto(`${URL_BASE}#/how`);
    await page.locator(".diagram svg").waitFor();
    await page.screenshot({ path: path.join(SHOTS, "how-it-works.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(URL_BASE);
    await page.getByTestId("lobby-table").first().waitFor();
    await sleep(2500);
    await page.screenshot({ path: path.join(SHOTS, "lobby-phone.png"), fullPage: true });

    // ================= part 2: wallet-bound seat via the queued path, then close the page
    await page.setViewportSize({ width: 1320, height: 900 });
    await page.getByRole("button", { name: /^Wallet/ }).click();
    await page.getByRole("button", { name: /E2E Test Wallet/ }).click();
    await page.getByText(/E2E Test Wallet connected/).waitFor({ timeout: 10_000 });
    const recBefore = await client.fetchRecord(walletKp.publicKey);
    log(`wallet connected in the UI: ${walletKp.publicKey.toBase58()} (record rounds before: ${recBefore?.rounds ?? "none"})`);
    await page.locator(".wallet > button").click(); // close the wallet menu

    // Prefer a table that is mid-round (wait up to 90 s for one), to exercise "seat me at the bell".
    let states: { h: (typeof HOUSE_TABLES)[number]; t: Awaited<ReturnType<typeof client.fetchTable>> | null }[] = [];
    let trading: typeof states = [];
    for (let i = 0; i < 30 && trading.length === 0; i++) {
      if (i) await sleep(3000);
      states = await Promise.all(
        HOUSE_TABLES.map(async (h) => ({ h, t: await client.fetchTable(client.er(), new PublicKey(h.address)).catch(() => null) })),
      );
      const now = Date.now() / 1000;
      trading = states.filter((x) => x.t && x.t.phase === "trading" && x.t.tradeEndTs - now > 8 && x.t.seats.some((s) => s.kind === "bot"));
    }
    const target = (trading.sort((a, b) => a.t!.tradeEndTs - b.t!.tradeEndTs)[0] ?? states.find((x) => x.t))!;
    log(`part 2: ${target.h.name} is ${target.t!.phase}; opening it with ?play=1`);
    await page.goto(`${URL_BASE}#/t/${target.h.address}?play=1`);
    if (target.t!.phase === "trading") {
      await page.getByTestId("queued").waitFor({ timeout: 15_000 });
      log(`queued: "${(await page.getByTestId("queued").innerText()).trim()}"`);
    }
    await page.getByTestId("my-hand").waitFor({ timeout: 150_000 });
    const t2 = await client.fetchTable(client.er(), new PublicKey(target.h.address));
    const seat2 = seatOf(t2, guest.publicKey.toBase58());
    const boundTo = seat2 >= 0 ? t2.seats[seat2].wallet.toBase58() : "-";
    log(`seated at the bell in seat ${seat2}, round ${t2.round}; seat wallet ${boundTo === walletKp.publicKey.toBase58() ? "= the connected wallet (co-signed join)" : boundTo}`);
    if (boundTo !== walletKp.publicKey.toBase58()) throw new Error("seat is not bound to the wallet");
    await page.getByTestId("reveal").waitFor({ timeout: 150_000 });
    log("round 2 settled; waiting for the base-layer PlayerRecord");
    if (checkRecord) {
      let recAfter = recBefore;
      for (let i = 0; i < 20 && (recAfter?.rounds ?? 0) <= (recBefore?.rounds ?? 0); i++) {
        await sleep(2000);
        recAfter = await client.fetchRecord(walletKp.publicKey);
      }
      log(
        `PlayerRecord on base: rounds ${recBefore?.rounds} -> ${recAfter?.rounds}, best ${recAfter?.bestScore}, last round ${recAfter?.lastRound}, ` +
          `last table ${recAfter?.lastTable.toBase58().slice(0, 6)}`,
      );
      if ((recAfter?.rounds ?? 0) <= (recBefore?.rounds ?? 0)) throw new Error("PlayerRecord was not updated");
    }

    // Open one of the reveal's explorer links (ER transaction via the custom-cluster URL).
    const bellHref = await page
      .locator(".story a", { hasText: "bell transaction" })
      .first()
      .getAttribute("href", { timeout: 5000 })
      .catch(() => null);
    if (bellHref) {
      const ex = await ctx.newPage();
      try {
        await ex.goto(bellHref, { timeout: 45_000 });
        const ok = await ex
          .getByText(/Success|Finalized|Confirmed/)
          .first()
          .waitFor({ timeout: 30_000 })
          .then(() => true)
          .catch(() => false);
        // explorer.solana.com may answer headless browsers with a bot checkpoint; report, don't fail.
        log(`explorer link for the bell renders the transaction: ${ok ? "yes" : "no (not confirmed by the page within 30 s)"}`);
      } catch (e) {
        log(`explorer link could not be opened: ${String((e as Error).message).split("\n")[0]}`);
      } finally {
        await ex.close();
      }
    }

    // Close the page while seated: the app fires its pre-signed `leave` on pagehide.
    await page.goto("about:blank");
    let freed = false;
    for (let i = 0; i < 10 && !freed; i++) {
      await sleep(1500);
      const t3 = await client.fetchTable(client.er(), new PublicKey(target.h.address));
      freed = seatOf(t3, guest.publicKey.toBase58()) < 0;
    }
    log(`page closed while seated -> seat freed by the pagehide leave: ${freed ? "yes" : "NO"}`);
    if (!freed) throw new Error("pagehide leave did not free the seat");

    if (errors.length) {
      log(`${errors.length} browser errors:`);
      errors.slice(0, 15).forEach((e) => log("   ", e));
    }
    log("E2E PASS");
  } finally {
    await browser?.close().catch(() => {});
    server.kill("SIGTERM");
    await freeSeats(client, guest).catch((e) => log("cleanup failed:", String(e)));
  }
}

main().catch((e) => {
  console.error("E2E FAIL:", e?.message ?? e);
  process.exit(1);
});

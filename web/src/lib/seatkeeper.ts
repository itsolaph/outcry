// App-level seat hygiene. Seats can only be freed by their owner (`leave`), so wherever the guest
// is in the app (table, lobby, how-it-works), keep a freshly signed `leave` for the seat it holds
// and fire it when the page goes away.
import { useEffect } from "react";
import { PublicKey } from "@solana/web3.js";
import { seatOf } from "@outcry/client";
import { HOUSE_TABLES } from "../config";
import { clearPreparedLeave, firePreparedLeave, prepareLeave } from "./actions";
import { anonEr, client, sessionKey } from "./outcry";

export function useSeatKeeper(): void {
  useEffect(() => {
    let alive = true;
    const me = sessionKey().publicKey.toBase58();
    const scan = async () => {
      for (const h of HOUSE_TABLES) {
        const table = new PublicKey(h.address);
        const t = await client.fetchTable(anonEr, table).catch(() => null);
        if (!alive || !t) continue;
        const i = seatOf(t, me);
        if (i >= 0) {
          await prepareLeave(table, i).catch(() => {});
          return;
        }
      }
      if (alive) clearPreparedLeave();
    };
    scan();
    const id = setInterval(scan, 10_000);
    const onHide = () => firePreparedLeave();
    window.addEventListener("pagehide", onHide);
    return () => {
      alive = false;
      clearInterval(id);
      window.removeEventListener("pagehide", onHide);
    };
  }, []);
}

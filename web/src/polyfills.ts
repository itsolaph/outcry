// Must be the first import of the app: web3.js, Anchor and the Outcry client use Node's Buffer
// at module load time.
import { Buffer } from "buffer";

const g = globalThis as unknown as { Buffer?: typeof Buffer };
if (!g.Buffer) g.Buffer = Buffer;

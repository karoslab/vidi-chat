import { verifyControlToken } from "@/lib/control";
import { mintPairingCode } from "@/lib/phone-browser-pairing";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * Mint a one-time phone-browser pairing code (see lib/phone-browser-pairing.ts
 * and GET /pair). Control-token gated: only ops/vidictl on this machine can
 * mint — a tailnet peer or drive-by page cannot manufacture its own pairing
 * link. Returns the path to open on the phone; the caller composes the full
 * tailnet URL (the server does not know its own ts.net name).
 */
export async function POST(req: Request) {
  if (!verifyControlToken(req)) {
    return Response.json({ error: "invalid or missing control token" }, { status: 401 });
  }
  const { code, expiresAtEpochMs } = mintPairingCode();
  return Response.json({ code, expiresAtEpochMs, path: `/pair?code=${code}` });
}

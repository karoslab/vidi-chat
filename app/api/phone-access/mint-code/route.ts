import { mintPairingCode } from "@/lib/phone-browser-pairing";
import { readiness } from "@/lib/phone-access";
import { requireWriteAuth, requireJsonContentType } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * POST -> mint a one-time phone-browser pairing code (the EXISTING seam,
 * lib/phone-browser-pairing.ts mintPairingCode) and, because this service can
 * now detect its own address, return the full address to type on the phone.
 *
 * WRITE-gated (session / control), NOT the phone token. Security model (B7
 * amendment, see THREAT_MODEL.md): a session-token holder already has full
 * read+write on this single-user install, so letting the session mint a pairing
 * code grants it no new privilege; the code is still 10-minute single-use. The
 * phone token deliberately does NOT pass requireWriteAuth, so a device that only
 * holds the phone token cannot self-mint fresh pairing codes. The control-token
 * ops route (app/api/phone/pair-code) stays untouched for scripted use.
 */
export async function POST(req: Request) {
  const unauthorized = requireWriteAuth(req);
  if (unauthorized) return unauthorized;
  const badType = requireJsonContentType(req);
  if (badType) return badType;

  const { code, expiresAtEpochMs } = mintPairingCode();
  // Best-effort address so the payoff screen can show it next to the code. A
  // machine that can't answer (no Tailscale) simply returns null here; the
  // customer is already on the connection page in that case.
  let deviceName: string | null = null;
  try {
    deviceName = (await readiness()).deviceName;
  } catch {
    deviceName = null;
  }
  return Response.json({ code, expiresAtEpochMs, path: `/pair?code=${code}`, deviceName });
}

import { requireJsonContentType, requireReadAuth, requireWriteAuth } from "@/lib/origin";
import {
  buildReportBundle,
  hasInstallKey,
  renderReportText,
  sendFeedback,
} from "@/lib/feedback";
import { weeklySummaryConsent } from "@/lib/feedback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * Feedback compose backend (DIAGNOSTICS + FEEDBACK loop).
 *
 * GET  → { hasKey, weeklyConsent, report } — the EXACT scrubbed technical report
 *        the compose screen previews before send (built from the ledger only; no
 *        chat content / paths / tokens by construction). requireReadAuth.
 * POST { text, includeReport? } → send to the owner via the vidi-proxy worker
 *        using this install's key. requireWriteAuth. Zero silent egress: this is
 *        only ever reached from the compose screen's Send button.
 *
 * Plain-language result: no key stored → 200 { sent:false, reason:"no-key" } so
 * the UI can explain reports need the connection code (point to Settings); a
 * delivery failure → 502 with a plain message.
 */
export async function GET(req: Request) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  const bundle = buildReportBundle();
  return Response.json({
    hasKey: hasInstallKey(),
    weeklyConsent: weeklySummaryConsent(),
    report: renderReportText(bundle),
  });
}

export async function POST(req: Request) {
  const unauthorized = requireWriteAuth(req);
  if (unauthorized) return unauthorized;
  const badContentType = requireJsonContentType(req);
  if (badContentType) return badContentType;

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return Response.json(
      { error: "Add a short note before sending." },
      { status: 400 }
    );
  }
  const includeReport = body.includeReport === true;

  const result = await sendFeedback({ text, includeReport });
  if (result.ok) {
    return Response.json({ sent: true });
  }
  if (result.reason === "no-key") {
    // Not an error the user can't recover from — plain 200 the UI turns into
    // guidance (reports need the connection code; see Settings).
    return Response.json({ sent: false, reason: "no-key" });
  }
  return Response.json(
    { sent: false, reason: "delivery-failed", error: "Couldn't send that just now. Try again in a moment." },
    { status: 502 }
  );
}

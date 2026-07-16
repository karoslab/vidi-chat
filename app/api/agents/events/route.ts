import { isUserVisibleOrigin, listVisibleAgents, subscribe } from "@/lib/agents/manager";
import type { FleetEvent } from "@/lib/agents/manager";
import { authorizedByToken, crossOriginResponse, sameOriginOk } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * Multiplexed SSE for the whole fleet: an initial snapshot, then one event
 * per fleet change (spawn / close / update / per-agent feed line). The
 * /canvas page consumes this to render live cards.
 *
 * Consumed by the browser via EventSource, which CANNOT set request headers, so
 * the layout fetch-shim can't attach the session token here. Gate: a valid
 * token (native/ops callers) OR sameOriginOk (the browser EventSource — a
 * same-origin request with no Origin, and a foreign-Origin/foreign-Host page is
 * rejected). This closes the tailscale-serve HTTPS-proxy door (ts.net Host is
 * outside the loopback allowlist → rejected). Residual: a raw-TCP tailnet client
 * that forges Host:127.0.0.1 with no Origin still passes — the operational fix
 * is to drop the `serve --tcp 4183` forward (see PR body). Fleet activity is
 * lower-sensitivity than the journal/transcript reads, which are hard-token-gated.
 */
export async function GET(req: Request) {
  if (!authorizedByToken(req) && !sameOriginOk(req)) return crossOriginResponse();
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          /* client gone */
        }
      };
      // Canvas-facing: snapshot and stream ONLY user-initiated agents. Every
      // FleetEvent carries the agent's origin (spawn/close/update on .agent,
      // feed on .origin), so a background goal/system agent's spawn, feed lines,
      // updates, and close never reach the browser — it neither appears as a
      // pane nor counts toward "N active".
      send({ kind: "snapshot", agents: listVisibleAgents() });
      const forwardIfVisible = (e: FleetEvent) => {
        const origin = e.kind === "feed" ? e.origin : e.agent.origin;
        if (isUserVisibleOrigin(origin)) send(e);
      };
      unsubscribe = subscribe(forwardIfVisible);
      // Heartbeat keeps intermediaries from closing an idle stream.
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: hb\n\n`));
        } catch {
          /* client gone */
        }
      }, 25_000);
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

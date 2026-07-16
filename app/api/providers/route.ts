import { providers } from "@/lib/providers";
import { requireReadAuth } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export async function GET(req: Request) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  const out = await Promise.all(
    Object.values(providers).map(async (p) => {
      const avail = await p.available();
      return {
        id: p.id,
        label: p.label,
        models: p.models,
        available: avail.ok,
        reason: avail.reason ?? null,
      };
    })
  );
  return Response.json({ providers: out });
}

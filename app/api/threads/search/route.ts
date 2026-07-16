import { NextRequest } from "next/server";
import { searchThreads } from "@/lib/store";
import { requireReadAuth } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/** GET → thread search (leaks message content). Token gated (Tier-2). */
export async function GET(req: NextRequest) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  const q = req.nextUrl.searchParams.get("q") ?? "";
  return Response.json({ threads: searchThreads(q) });
}

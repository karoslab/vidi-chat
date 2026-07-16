import {
  PERSONALITIES,
  completeOnboarding,
  isOnboarded,
  readProfile,
  type PersonalityId,
} from "@/lib/onboarding";
import { actModeAllowed, getUserConfig, isOwner } from "@/lib/user-config";
import { requireJsonContentType, requireReadAuth, requireWriteAuth } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * First-run onboarding state.
 *
 * GET  → { onboarded, profile, personalities } — the UI reads this once on
 *         load to decide whether to show the flow. An existing install
 *         (the owner) always reports onboarded:true (existing-data rule).
 * POST  { name, personality } → complete the flow (fresh install only). If the
 *         install is already onboarded this is a no-op that just returns the
 *         current state, so it can never rewrite an existing user's config.
 */
export async function GET(req: Request) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  return Response.json({
    onboarded: isOnboarded(),
    profile: readProfile(),
    // How Vidi should address this user in the greeting — the profile name if
    // onboarding wrote one, else the user-config display name (the owner's
    // default "the owner", so his greeting is unchanged with no profile file).
    displayName: readProfile()?.name ?? getUserConfig().displayName,
    personalities: PERSONALITIES,
    // Which security-notice story is TRUE for this install (V2 non-owner track):
    // an owner install (VIDI_OWNER=1) can flip Plan→Auto herself and voice is
    // live; a non-owner install is clamped to Plan with the egress gates off.
    // The client component can't read env/data files, so the flag rides here.
    ownerInstall: isOwner(),
    // Whether the ACTING surface (Auto mode) is reachable at all on this install
    // — owner, or a non-owner the owner opted in via VIDI_ACT_OPT_IN. The composer
    // renders Mode read-only ("Plan mode") when this is false. Owner → true, so
    // the owner's Plan/Auto toggle is unchanged.
    actModeAllowed: actModeAllowed(),
  });
}

export async function POST(req: Request) {
  // P8 finding 3 follow-up: completing onboarding writes the profile/config
  // that isOwner()-adjacent logic later reads — require a positive
  // session/control token, matching the GET's requireReadAuth gate.
  const unauthorized = requireWriteAuth(req);
  if (unauthorized) return unauthorized;
  const badContentType = requireJsonContentType(req);
  if (badContentType) return badContentType;

  // Never re-run onboarding for an existing install — guard BEFORE reading the
  // body so a stray POST can't touch the owner's config.
  if (isOnboarded()) {
    return Response.json({ onboarded: true, profile: readProfile(), alreadyOnboarded: true });
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name : "";
  const personality = body.personality as PersonalityId;
  const profile = completeOnboarding({ name, personality });
  return Response.json({ onboarded: true, profile });
}

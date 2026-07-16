import {
  ConfigValidationError,
  EDITABLE_CONFIG_FIELDS,
  getEditableConfigWithSources,
  writeEditableConfig,
  type EditableConfigField,
} from "@/lib/user-config";
import { requireJsonContentType, requireReadAuth, requireWriteAuth } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * Settings panel backend (T1.3). Exposes the user-editable subset of the
 * de-personalize config — displayName / brainDirName — plus, per field, whether
 * an environment variable is locking it (the panel shows a "set by environment"
 * badge and disables the input). homeDir is NOT editable here (F5): it feeds the
 * CLI write-jail, so it stays env/file-only and this route can't write it.
 *
 * GET  → { fields: { <name>: { value, envLocked } } }
 * POST { displayName?, brainDirName? } → merge into data/user-config.json
 *        (env-locked fields skipped) and return the fresh field state.
 *        Same-origin guarded like every state-changing route.
 */
export async function GET(req: Request) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  return Response.json({ fields: getEditableConfigWithSources() });
}

export async function POST(req: Request) {
  // P8 finding 3: writing user-config flips owner-inference-adjacent state the
  // agent later reads — require a positive session/control token, not
  // sameOriginOk alone (matches the GET's requireReadAuth gate).
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

  // Accept only the known editable fields, and only string values.
  const overrides: Partial<Record<EditableConfigField, string>> = {};
  for (const fieldName of EDITABLE_CONFIG_FIELDS) {
    if (typeof body[fieldName] === "string") overrides[fieldName] = body[fieldName];
  }

  try {
    const fields = writeEditableConfig(overrides);
    return Response.json({ fields });
  } catch (err) {
    // A validation failure (e.g. a traversal in brainDirName) carries a
    // plain-language message that's safe to show verbatim → 400. Anything else
    // (an unwritable file) stays a generic 500 with the raw detail in the log.
    if (err instanceof ConfigValidationError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    console.error("[user-config] write failed:", err);
    return Response.json(
      { error: "Couldn't save your settings just now. Try again in a moment." },
      { status: 500 }
    );
  }
}

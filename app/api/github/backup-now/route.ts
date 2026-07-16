import { requireWriteAuth } from "@/lib/origin";
import { status, ensureWikiBackupRepo, pushWikiBackup, NOT_INSTALLED_MSG } from "@/lib/github-connect";
import { appendJournal } from "@/lib/journal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * POST /api/github/backup-now → make sure the private backup repo exists, then
 * push the customer's memory to it. Write-gated (it egresses data). The
 * MANDATORY secret gate runs inside pushWikiBackup: if a file looks like it
 * holds a credential the push is BLOCKED and the file is named in plain words —
 * this route surfaces that as a 422 with the customer message, nothing leaves
 * the machine.
 */
export async function POST(req: Request) {
  const unauthorized = requireWriteAuth(req);
  if (unauthorized) return unauthorized;

  const who = await status();
  if (who.notInstalled) {
    return Response.json({ error: NOT_INSTALLED_MSG, kind: "not-installed" }, { status: 503 });
  }
  if (!who.connected || !who.login) {
    return Response.json({ error: "Connect your GitHub account first.", kind: "denied" }, { status: 409 });
  }

  const repo = await ensureWikiBackupRepo(who.login);
  if (!repo.ok || !repo.fullName) {
    return Response.json({ error: repo.reason, kind: repo.kind }, { status: 502 });
  }

  const result = await pushWikiBackup(undefined, repo.fullName);
  if (!result.ok) {
    // Secret-blocked is a fixable customer condition, not a server error.
    if (result.kind === "secret-blocked") {
      appendJournal({
        ts: Date.now(),
        threadId: "github",
        tool: "backup-blocked",
        summary: `secret gate blocked backup (${result.secrets?.length ?? 0} finding(s))`,
      });
      return Response.json(
        {
          error: result.reason,
          kind: "secret-blocked",
          // file+line only — never the matched text (that's the secret).
          findings: (result.secrets ?? []).map((f) => ({ file: f.file, line: f.line })),
        },
        { status: 422 }
      );
    }
    return Response.json({ error: result.reason, kind: result.kind }, { status: 502 });
  }

  appendJournal({
    ts: Date.now(),
    threadId: "github",
    tool: "backup",
    summary: `backed up to ${repo.fullName}`,
  });
  return Response.json({ ok: true, repo: repo.fullName, message: result.reason });
}

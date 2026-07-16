import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Regression lock for the 2026.07.12 wizard-connect fix.
 *
 * The native Vidi Helper's "Connect AI provider" menu row was removed (launcher
 * PR #12). No CUSTOMER-FACING copy anywhere may still tell someone to open that
 * menu to connect — the in-app flow (ClaudeStep, embedded in the wizard and the
 * setup board) is the connect path now. Code comments that describe the history
 * ("the in-app port of the Helper's flow") are fine; only rendered strings are
 * the hazard.
 *
 * This walks components/ and lib/ and asserts every occurrence of the retired
 * phrases lives on a comment line, never in a string literal or JSX text.
 */

const ROOT = path.join(import.meta.dirname, "..");
const DIRS = ["components", "lib", "app"];
const PHRASES = ["Connect AI provider", "Open Vidi Helper"];

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
}

/** A line is a comment if it's a // line or a /* ... *​/ or JSDoc (* ...) line.
 *  Good enough for this codebase: every legit remaining hit is a JSDoc line. */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

test("no customer-facing copy points at the retired Helper 'Connect AI provider' menu", () => {
  const files: string[] = [];
  for (const d of DIRS) {
    const abs = path.join(ROOT, d);
    if (fs.existsSync(abs)) walk(abs, files);
  }

  const violations: string[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (PHRASES.some((p) => line.includes(p)) && !isCommentLine(line)) {
        violations.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(
    violations,
    [],
    `Customer-facing Helper-menu copy still present:\n${violations.join("\n")}`
  );
});

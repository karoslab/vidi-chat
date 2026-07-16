import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyTaskShape, detectDelegation, extractDelegatedTask } from "../lib/agents/delegate.ts";

// ── explicit requests delegate in any mode ─────────────────────────────

test("explicit: 'spawn an agent to…' delegates even in plan mode", () => {
  assert.equal(
    detectDelegation("spawn an agent to research WKWebView pitfalls", "plan"),
    "explicit"
  );
});

test("explicit: 'have an agent do this' delegates", () => {
  assert.equal(
    detectDelegation("have an agent clean up the ops logs", "auto"),
    "explicit"
  );
});

test("explicit: 'delegate this' delegates", () => {
  assert.equal(
    detectDelegation("delegate this: rewrite the README", "auto"),
    "explicit"
  );
});

test("explicit: 'do this in the background' delegates", () => {
  assert.equal(
    detectDelegation("run the full qa sweep in the background", "auto"),
    "explicit"
  );
});

// ── complex asks delegate only in auto mode ────────────────────────────

test("complex: depth phrase + work verb in auto mode delegates", () => {
  assert.equal(
    detectDelegation("do a deep dive and research how launchd throttling works", "auto"),
    "complex"
  );
});

test("complex: long work-shaped ask in auto mode delegates", () => {
  const longAsk =
    "build a small dashboard page for the ops layer that reads every launchd job's " +
    "last run status from the logs directory, shows a red/green grid per job, " +
    "refreshes every minute, and links each job to its most recent log file so " +
    "I can see at a glance what failed overnight without opening a terminal";
  assert.equal(detectDelegation(longAsk, "auto"), "complex");
});

test("complex ask in plan mode does NOT delegate", () => {
  assert.equal(
    detectDelegation("do a deep dive and research how launchd throttling works", "plan"),
    null
  );
});

// ── ordinary chat stays inline ─────────────────────────────────────────

test("short question does not delegate", () => {
  assert.equal(detectDelegation("what port does demo-app run on?", "auto"), null);
});

test("mentioning agents in passing does not delegate", () => {
  assert.equal(
    detectDelegation("what do you think about AI agents?", "auto"),
    null
  );
});

test("long but non-work message does not delegate", () => {
  const rambling =
    "so I was thinking today about how the whole local setup has grown since " +
    "June and honestly it's kind of wild how many moving pieces there are now, " +
    "between the launchd jobs and the discord notifications and the deploy gates, " +
    "and I wonder sometimes whether it all still makes sense as one system";
  assert.equal(detectDelegation(rambling, "auto"), null);
});

// ── task extraction ────────────────────────────────────────────────────

test("extract strips the spawn preamble", () => {
  assert.equal(
    extractDelegatedTask("spawn an agent to research WKWebView pitfalls"),
    "research WKWebView pitfalls"
  );
});

test("extract keeps the message when there is no preamble", () => {
  assert.equal(
    extractDelegatedTask("audit the whole ops directory for dead scripts"),
    "audit the whole ops directory for dead scripts"
  );
});

test("extract falls back to full message when the strip leaves nothing", () => {
  assert.equal(extractDelegatedTask("spawn an agent"), "spawn an agent");
});

// ── task shape → model policy ──────────────────────────────────────────

test("build-shaped tasks classify as build (→ opus+ultracode via auto+high)", () => {
  assert.equal(classifyTaskShape("build a dashboard for the ops jobs"), "build");
  assert.equal(classifyTaskShape("refactor the journal module"), "build");
  assert.equal(classifyTaskShape("do a deep dive on WKWebView audio"), "build");
  assert.equal(classifyTaskShape("investigate why the heartbeat flaps"), "build");
});

test("mechanical errands classify as mechanical (→ sonnet)", () => {
  assert.equal(classifyTaskShape("rename the file to notes.md"), "mechanical");
  assert.equal(classifyTaskShape("list the open PRs"), "mechanical");
  assert.equal(classifyTaskShape("what time is the dg sweep"), "mechanical");
});

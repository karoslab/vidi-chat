import { test } from "node:test";
import assert from "node:assert/strict";

const { matchFleetIntent } = await import("../lib/agents/intents.ts");

// Sentry vs macro precedence — the trap this file exists for: bare
// "watch this" teaches a macro; "watch this <surface>" starts a sentry watch.

test("bare 'watch this' still records a macro", () => {
  assert.deepEqual(matchFleetIntent("vidi, watch this"), {
    kind: "macroRecord",
    name: "quicksave",
  });
});

test("'watch this as deploy-dance' still records a named macro", () => {
  assert.deepEqual(matchFleetIntent("watch this as deploy-dance"), {
    kind: "macroRecord",
    name: "deploy-dance",
  });
});

test("'watch this window' starts a sentry watch with the default goal", () => {
  const intent = matchFleetIntent("vidi, watch this window");
  assert.equal(intent?.kind, "sentryStart");
  assert.equal((intent as any).audio, false);
  assert.equal((intent as any).trigger, undefined);
  assert.ok((intent as any).goal.includes("something meaningful"));
});

test("literal trigger: 'watch this window and tell me when it says build succeeded'", () => {
  assert.deepEqual(
    matchFleetIntent("watch this window and tell me when it says build succeeded"),
    { kind: "sentryStart", trigger: "build succeeded", audio: false }
  );
});

test("literal trigger via 'until it says'", () => {
  assert.deepEqual(matchFleetIntent("watch the window until it says done"), {
    kind: "sentryStart",
    trigger: "done",
    audio: false,
  });
});

test("fuzzy goal: 'watch this window and tell me when the download finishes'", () => {
  assert.deepEqual(
    matchFleetIntent("watch this window and tell me when the download finishes"),
    { kind: "sentryStart", goal: "the download finishes", audio: false }
  );
});

test("'watch this video' captures audio", () => {
  const intent = matchFleetIntent("vidi, watch this video");
  assert.equal(intent?.kind, "sentryStart");
  assert.equal((intent as any).audio, true);
});

test("'stop watching the window' is sentry, bare 'stop watching' stays macro", () => {
  assert.deepEqual(matchFleetIntent("stop watching the window"), { kind: "sentryStop" });
  assert.deepEqual(matchFleetIntent("stop watching the video"), { kind: "sentryStop" });
  assert.deepEqual(matchFleetIntent("vidi, stop watching"), { kind: "macroStop" });
});

test("video Q&A phrases map to sentrySummarize", () => {
  assert.deepEqual(matchFleetIntent("what did the video say"), { kind: "sentrySummarize" });
  assert.deepEqual(matchFleetIntent("summarize the video"), { kind: "sentrySummarize" });
});

test("'are you watching' maps to sentryStatus", () => {
  assert.deepEqual(matchFleetIntent("are you watching"), { kind: "sentryStatus" });
  assert.deepEqual(matchFleetIntent("are you still watching the video"), { kind: "sentryStatus" });
});

test("'remember this:' becomes a note; 'do you remember…' falls through", () => {
  assert.deepEqual(matchFleetIntent("vidi, remember this: the deploy window is 9am"), {
    kind: "remember",
    note: "the deploy window is 9am",
  });
  assert.deepEqual(matchFleetIntent("remember that demo-app ships friday"), {
    kind: "remember",
    note: "demo-app ships friday",
  });
  // Questions about memory are never note WRITES. ("do you remember…" hits
  // the pre-existing greedy macroPlay rule via its "do " prefix — that's fine:
  // the handler falls through to a normal turn when no macro matches.)
  const question = matchFleetIntent("do you remember when we shipped the app");
  assert.notEqual(question?.kind, "remember");
  assert.equal(matchFleetIntent("you remember when we shipped the app right"), null);
});

test("widened remember forms: don't forget / remember: / note that", () => {
  assert.deepEqual(matchFleetIntent("vidi, don't forget the dentist is at 2pm"), {
    kind: "remember",
    note: "the dentist is at 2pm",
  });
  assert.deepEqual(matchFleetIntent("remember: the staging key is in the vault"), {
    kind: "remember",
    note: "the staging key is in the vault",
  });
  assert.deepEqual(matchFleetIntent("note that myapp needs a scope re-auth"), {
    kind: "remember",
    note: "myapp needs a scope re-auth",
  });
  // Bare "remember" WITHOUT a colon stays a question/conversation, so
  // "remember when…" reminiscing never becomes an accidental note write.
  const reminiscing = matchFleetIntent("remember when we built the dashboard");
  assert.notEqual(reminiscing?.kind, "remember");
});

test("standing report phrases map to standingReport", () => {
  assert.deepEqual(matchFleetIntent("vidi, good morning"), { kind: "standingReport" });
  assert.deepEqual(matchFleetIntent("what's broken"), { kind: "standingReport" });
  assert.deepEqual(matchFleetIntent("standing report"), { kind: "standingReport" });
  // "good morning everyone" is conversation, not a report request.
  assert.equal(matchFleetIntent("good morning everyone"), null);
});

test("quiet mode on: bare commands map to quietMode on", () => {
  assert.deepEqual(matchFleetIntent("vidi, quiet mode on"), {
    kind: "quietMode",
    on: true,
  });
  assert.deepEqual(matchFleetIntent("go quiet"), { kind: "quietMode", on: true });
  assert.deepEqual(matchFleetIntent("do not disturb on"), {
    kind: "quietMode",
    on: true,
  });
});

test("quiet mode off: bare commands map to quietMode off", () => {
  assert.deepEqual(matchFleetIntent("quiet mode off"), {
    kind: "quietMode",
    on: false,
  });
  assert.deepEqual(matchFleetIntent("you can talk"), {
    kind: "quietMode",
    on: false,
  });
  assert.deepEqual(matchFleetIntent("do not disturb off"), {
    kind: "quietMode",
    on: false,
  });
});

test("'how do I turn on dark mode' must NOT match quietMode", () => {
  const intent = matchFleetIntent("how do I turn on dark mode");
  assert.notEqual(intent?.kind, "quietMode");
});

test("bare affirmatives map to confirm; a longer 'yes' sentence falls through", () => {
  assert.deepEqual(matchFleetIntent("confirm"), { kind: "confirm" });
  assert.deepEqual(matchFleetIntent("vidi, go ahead"), { kind: "confirm" });
  assert.deepEqual(matchFleetIntent("do it"), { kind: "confirm" });
  assert.deepEqual(matchFleetIntent("yes do it"), { kind: "confirm" });
  // A qualified yes is a normal turn, not a blind confirm.
  assert.notEqual(matchFleetIntent("yes I think we should ship it")?.kind, "confirm");
});

test("cancel phrases map to cancelPending", () => {
  assert.deepEqual(matchFleetIntent("cancel that"), { kind: "cancelPending" });
  assert.deepEqual(matchFleetIntent("never mind"), { kind: "cancelPending" });
  assert.deepEqual(matchFleetIntent("forget it"), { kind: "cancelPending" });
});

test("brief-me phrases map to briefMe", () => {
  assert.deepEqual(matchFleetIntent("vidi, brief me"), { kind: "briefMe" });
  assert.deepEqual(matchFleetIntent("what's waiting"), { kind: "briefMe" });
  assert.deepEqual(matchFleetIntent("anything for me"), { kind: "briefMe" });
  assert.deepEqual(matchFleetIntent("what did I miss"), { kind: "briefMe" });
});

test("new goal phrasings map to newGoal with the title", () => {
  assert.deepEqual(matchFleetIntent("vidi, new goal: ship demo-app phase one"), {
    kind: "newGoal",
    title: "ship demo-app phase one",
  });
  assert.deepEqual(matchFleetIntent("set a goal to hit 90% coverage on demo-app"), {
    kind: "newGoal",
    title: "hit 90% coverage on demo-app",
  });
  assert.deepEqual(matchFleetIntent("your goal is keep the dashboard green"), {
    kind: "newGoal",
    title: "keep the dashboard green",
  });
});

test("goal status phrasings map to goalStatus", () => {
  assert.deepEqual(matchFleetIntent("goal status"), { kind: "goalStatus" });
  assert.deepEqual(matchFleetIntent("how are the goals"), { kind: "goalStatus" });
  assert.deepEqual(matchFleetIntent("what are you working on long term"), {
    kind: "goalStatus",
  });
});

test("pause/resume/drop the goal X map to the right mutation", () => {
  assert.deepEqual(matchFleetIntent("pause the goal coverage"), {
    kind: "pauseGoal",
    name: "coverage",
  });
  assert.deepEqual(matchFleetIntent("resume the demo-app goal"), {
    kind: "resumeGoal",
    name: "demo-app",
  });
  assert.deepEqual(matchFleetIntent("drop the goal ship-demo"), {
    kind: "dropGoal",
    name: "ship-demo",
  });
});

// C2 system fast-path — device commands mapped to native verbs, no LLM turn.

test("timer phrasings map to system:timer with minutes", () => {
  assert.deepEqual(matchFleetIntent("vidi, set a timer for 10 minutes"), {
    kind: "system",
    verb: "timer",
    args: { minutes: 10 },
  });
  assert.deepEqual(matchFleetIntent("timer 5 minutes"), {
    kind: "system",
    verb: "timer",
    args: { minutes: 5 },
  });
  assert.deepEqual(matchFleetIntent("3 minute timer"), {
    kind: "system",
    verb: "timer",
    args: { minutes: 3 },
  });
});

test("volume phrasings map to system:volume with a numeric level", () => {
  assert.deepEqual(matchFleetIntent("volume 40"), {
    kind: "system",
    verb: "volume",
    args: { level: 40 },
  });
  assert.deepEqual(matchFleetIntent("set the volume to 80"), {
    kind: "system",
    verb: "volume",
    args: { level: 80 },
  });
});

test("'mute the volume' mutes audio; bare 'mute yourself' stays quietMode", () => {
  assert.deepEqual(matchFleetIntent("mute the volume"), {
    kind: "system",
    verb: "mute",
    args: { on: true },
  });
  assert.deepEqual(matchFleetIntent("unmute"), {
    kind: "system",
    verb: "mute",
    args: { on: false },
  });
  // bare "mute yourself" is the quiet-mode override, NOT an audio mute.
  assert.deepEqual(matchFleetIntent("mute yourself"), { kind: "quietMode", on: true });
});

test("'pause the music' / 'play' map to system:mediaPlayPause (not macroPlay)", () => {
  assert.deepEqual(matchFleetIntent("pause the music"), {
    kind: "system",
    verb: "mediaPlayPause",
    args: {},
  });
  assert.deepEqual(matchFleetIntent("pause"), {
    kind: "system",
    verb: "mediaPlayPause",
    args: {},
  });
  assert.deepEqual(matchFleetIntent("play"), {
    kind: "system",
    verb: "mediaPlayPause",
    args: {},
  });
  assert.deepEqual(matchFleetIntent("resume the music"), {
    kind: "system",
    verb: "mediaPlayPause",
    args: {},
  });
});

test("'next track' / 'previous song' map to media next/prev", () => {
  assert.deepEqual(matchFleetIntent("next track"), {
    kind: "system",
    verb: "mediaNext",
    args: {},
  });
  assert.deepEqual(matchFleetIntent("skip"), {
    kind: "system",
    verb: "mediaNext",
    args: {},
  });
  assert.deepEqual(matchFleetIntent("previous track"), {
    kind: "system",
    verb: "mediaPrev",
    args: {},
  });
  assert.deepEqual(matchFleetIntent("go back a song"), {
    kind: "system",
    verb: "mediaPrev",
    args: {},
  });
});

test("'open <app>' maps to system:openApp; long phrases fall through", () => {
  assert.deepEqual(matchFleetIntent("open safari"), {
    kind: "system",
    verb: "openApp",
    args: { name: "Safari" },
  });
  assert.deepEqual(matchFleetIntent("vidi, open spotify"), {
    kind: "system",
    verb: "openApp",
    args: { name: "Spotify" },
  });
  // 3+ word object is not a short app name → falls through to a normal turn.
  assert.equal(matchFleetIntent("open the pod bay doors")?.kind !== "system", true);
});

test("'remind me to <text>' maps to system:reminder", () => {
  assert.deepEqual(matchFleetIntent("remind me to call the dentist"), {
    kind: "system",
    verb: "reminder",
    args: { text: "call the dentist" },
  });
  assert.deepEqual(matchFleetIntent("vidi, remind me to push the deploy"), {
    kind: "system",
    verb: "reminder",
    args: { text: "push the deploy" },
  });
});

test("'play devil's advocate with me' must NOT match a media/system verb", () => {
  const intent = matchFleetIntent("play devil's advocate with me");
  assert.notEqual(intent?.kind, "system");
});

test("unrelated transcripts still fall through", () => {
  assert.equal(matchFleetIntent("what's the weather like"), null);
  // "watch" without this/the/that/my + surface is not a sentry command.
  assert.equal(matchFleetIntent("watch out for the deploy"), null);
  // A normal sentence that merely mentions goals is NOT a goal command.
  assert.equal(matchFleetIntent("i think our main goal should be the family"), null);
});

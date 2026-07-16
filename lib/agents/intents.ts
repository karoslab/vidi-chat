/**
 * Voice/text grammar for fleet commands, matched in the voice route BEFORE
 * the default act-mode turn. Deliberately narrow: an unmatched transcript
 * falls through to normal Vidi, and "ask/close <name>" only acts if a live
 * agent with that name exists (resolved by the caller), so ordinary questions
 * that happen to start with "ask" aren't hijacked.
 */

export type FleetIntent =
  | { kind: "spawn"; provider: string; name?: string }
  | { kind: "ask"; name: string; task: string }
  | { kind: "close"; name: string }
  | { kind: "status" }
  | { kind: "loop"; goal: string }
  | { kind: "macroRecord"; name: string }
  | { kind: "macroStop" }
  | { kind: "macroList" }
  | { kind: "macroPlay"; name: string }
  | { kind: "sentryStart"; trigger?: string; goal?: string; audio: boolean }
  | { kind: "sentryStop" }
  | { kind: "sentryStatus" }
  | { kind: "sentrySummarize" }
  | { kind: "remember"; note: string }
  | { kind: "standingReport" }
  | { kind: "quietMode"; on: boolean }
  | { kind: "system"; verb: string; args: Record<string, unknown> }
  | { kind: "confirm" }
  | { kind: "cancelPending" }
  | { kind: "briefMe" }
  | { kind: "newGoal"; title: string }
  | { kind: "goalStatus" }
  | { kind: "pauseGoal"; name: string }
  | { kind: "resumeGoal"; name: string }
  | { kind: "dropGoal"; name: string };

function normalize(t: string): string {
  return t
    .toLowerCase()
    .replace(/[.!?,]+/g, " ")
    .replace(/\b(hey |ok )?vidi\b/g, " ")
    .replace(/\bplease\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchFleetIntent(transcript: string): FleetIntent | null {
  const t = normalize(transcript);

  // Confirm-tier answers — bare, whole-utterance affirmatives that clear the
  // one-slot pending action (lib/confirm). Anchored on the WHOLE utterance so
  // "yes I think we should refactor it" stays a normal turn: only a terse
  // "confirm"/"go ahead"/"do it"/"yes do it" fires. Placed FIRST so no later
  // rule (e.g. macroPlay's greedy "do <x>") can swallow "do it".
  if (/^(?:confirm|go ahead|yes do it|yep do it|do it|yes go ahead)$/.test(t)) {
    return { kind: "confirm" };
  }
  // Cancel the pending action ("cancel that" / "never mind" / "forget it").
  if (/^(?:cancel that|never ?mind|forget it|forget that|scratch that|cancel it)$/.test(t)) {
    return { kind: "cancelPending" };
  }
  // Brief me — read out the queued proactivity items ("brief me" / "what's
  // waiting" / "anything for me" / "what did I miss"). Whole-utterance so a
  // longer sentence that merely contains these words stays a normal turn.
  if (
    /^(?:brief me|what(?:'| i)?s waiting(?: for me)?|anything (?:for me|waiting|i missed)|what did i miss)$/.test(
      t
    )
  ) {
    return { kind: "briefMe" };
  }

  // status — check before the broad "ask" rule
  if (
    /^(fleet status|agent status|status of (the )?agents|what('| a)?re? (the )?agents (doing|up to)|what is the fleet doing)$/.test(
      t
    )
  ) {
    return { kind: "status" };
  }

  // loop: requires a connective so "loop me in on the call" isn't a loop.
  // "loop until <goal>" / "loop on <goal>" / "keep working until <goal>"
  const loop = t.match(/^(?:loop\s+(?:until|on|to)|keep working (?:until|on))\s+(.+)$/);
  if (loop) return { kind: "loop", goal: loop[1] };

  // Sentry Mode — MUST run before the macro rules: bare "watch this" teaches
  // a macro, but "watch this window/screen/tab/video ..." watches a surface.
  // "watch this video" always captures audio (a talking-head video's content
  // is its audio); a literal "says X" becomes a free on-device text trigger,
  // anything else becomes a capped vision goal.
  const sentry = t.match(
    /^(?:watch|keep an eye on)\s+(?:this|the|that|my)\s+(window|screen|tab|app|video)\b\s*(.*)$/
  );
  if (sentry) {
    const surface = sentry[1];
    // Strip connective lead-ins: "and tell me when …" / "until …" / "for …"
    const detail = sentry[2]
      .replace(/^and\s+/, "")
      .replace(/^(?:tell me|let me know|alert me|ping me)\s+(?:when|if)\s+/, "")
      .replace(/^(?:when|until|for|if)\s+/, "")
      .trim();
    const literalTrigger = detail.match(/^(?:it\s+|the\s+screen\s+)?(?:says|shows|displays)\s+(.+)$/);
    if (surface === "video") {
      return { kind: "sentryStart", audio: true, goal: detail && !literalTrigger ? detail : undefined, trigger: literalTrigger?.[1] };
    }
    if (literalTrigger) return { kind: "sentryStart", trigger: literalTrigger[1], audio: false };
    if (detail) return { kind: "sentryStart", goal: detail, audio: false };
    return {
      kind: "sentryStart",
      goal: "something meaningful happens — an error, a completion, or a big change",
      audio: false,
    };
  }
  if (/^stop watching(?:\s+(?:this|the|that|my))?\s+(?:window|screen|tab|app|video)$/.test(t)) {
    return { kind: "sentryStop" };
  }
  if (
    /^(?:what did (?:the video|he|she|they) say|summarize (?:the|this|that) video|what was (?:the|this|that) video about|what did i miss in the video)$/.test(t)
  ) {
    return { kind: "sentrySummarize" };
  }
  if (/^(?:are you (?:still )?watching(?: (?:it|the window|the video))?|watch status|sentry status)$/.test(t)) {
    return { kind: "sentryStatus" };
  }

  // "remember this: …" — a deliberate note into long-term memory. Anchored on
  // LEADING note-taking phrases so questions like "do you remember when…"
  // fall through to a normal turn. Bare "remember" requires a colon/comma
  // ("remember: …") so "remember when we shipped the app" stays a question.
  const remember = t.match(
    /^(?:remember (?:this|that)[:,]?|remember[:,]|don['’]?t forget[:,]?|note that|make a note[:,]?|note this down[:,]?)\s+(.+)$/
  );
  if (remember) return { kind: "remember", note: remember[1].trim() };

  // Standing Report — the spoken ops brief.
  if (
    /^(?:good morning|morning report|morning brief|standing report|status report|daily brief|what(?:'| i)?s broken(?: right now| today)?)$/.test(t)
  ) {
    return { kind: "standingReport" };
  }

  // Standing goals (Workstream C4 grammar). All LEADING-anchored so a question
  // like "how do I set a goal in the app" or "what's your goal here" that isn't
  // in the exact command shape falls through to a normal turn.
  //
  // New goal: "new goal: ship demo-app" / "set a goal to hit 90% coverage" /
  // "your goal is keep the dashboard green". A colon after "new goal" is
  // optional; "set a goal (to|of|:)" needs the connective so "set a goal" alone
  // isn't an empty-title goal.
  const newGoal = t.match(
    /^(?:new goal[:,]?|set (?:a |the )?goal (?:to|of|for|:)|add (?:a |the )?goal[:,]?(?: to)?|your goal is|make (?:it )?(?:a |your )?goal to)\s+(.+)$/
  );
  if (newGoal && newGoal[1].trim()) {
    return { kind: "newGoal", title: newGoal[1].trim() };
  }
  // Goal status: "goal status" / "how are the goals" / "what are you working on
  // long term". Whole-utterance so it stays a bare status question.
  if (
    /^(?:goal status|goals status|how (?:are|is) (?:the |your )?goals(?: (?:going|coming))?|what (?:are|is) (?:your |the )?goals|what are you working on (?:long ?term|over time)|(?:list|show)(?: me)? (?:the |your )?goals)$/.test(
      t
    )
  ) {
    return { kind: "goalStatus" };
  }
  // Pause / resume / drop a named goal: "pause the goal coverage",
  // "resume the demo-app goal", "drop the goal ship-demo". The verb+"goal"
  // pairing is required (either order) so "pause the video" — a different
  // surface — never becomes a goal mutation. The captured name is resolved to a
  // real goal by the handler; no match there falls through to a normal turn.
  const goalMutate = t.match(
    /^(pause|resume|unpause|drop|stop|cancel|abandon)\s+(?:the\s+)?(?:goal\s+(.+)|(.+?)\s+goal)$/
  );
  if (goalMutate) {
    const verb = goalMutate[1];
    const name = (goalMutate[2] ?? goalMutate[3] ?? "").trim();
    if (name) {
      if (verb === "pause" || verb === "stop") return { kind: "pauseGoal", name };
      if (verb === "resume" || verb === "unpause") return { kind: "resumeGoal", name };
      return { kind: "dropGoal", name }; // drop / cancel / abandon
    }
  }

  // Quiet mode — the manual override for the politeness engine. Anchored on
  // the WHOLE utterance so it only fires on a bare command: "quiet mode on",
  // "go quiet", "do not disturb off", "you can talk". The on/off word must sit
  // next to "quiet mode"/"do not disturb"/"dnd" (or be a fixed phrase like
  // "go quiet"), so "how do I turn on dark mode" — a different mode — falls
  // through to a normal turn instead of silencing Vidi.
  if (
    /^(?:(?:turn |switch )?quiet mode on|go quiet|be quiet|(?:turn |switch )?(?:on )?(?:do not disturb|dnd)(?: on)?|(?:turn |switch )?(?:do not disturb|dnd) mode on|zip it|mute yourself)$/.test(
      t
    )
  ) {
    return { kind: "quietMode", on: true };
  }
  if (
    /^(?:(?:turn |switch )?quiet mode off|you can talk|(?:turn |switch )?(?:off )?(?:do not disturb|dnd)(?: off)?|(?:turn |switch )?(?:do not disturb|dnd) mode off|speak up again|you can speak(?: up)?(?: again)?|unmute yourself)$/.test(
      t
    )
  ) {
    return { kind: "quietMode", on: false };
  }

  // C2 system fast-path — map common device commands straight to the app's
  // native action verbs with NO LLM turn (same pre-LLM intercept class as the
  // kill switch). Placed AFTER quietMode (so "do not disturb" stays quietMode)
  // and BEFORE the macro rules — a specific "play"/"pause the music" media rule
  // MUST come before macroPlay's greedy "play <name>". Every rule is anchored on
  // the WHOLE normalized utterance and conservative: a miss falls through to a
  // normal turn rather than firing the wrong verb.

  // Timer: "set a timer for N minutes" / "timer N minutes" / "N minute timer".
  const timer = t.match(
    /^(?:set (?:a |the )?timer for|timer(?: for)?)\s+(\d{1,3})\s*(?:minutes?|mins?|m)$/
  );
  if (timer) return { kind: "system", verb: "timer", args: { minutes: Number(timer[1]) } };
  const timerAlt = t.match(/^(\d{1,3})\s*(?:minute|min)s?\s+timer$/);
  if (timerAlt) return { kind: "system", verb: "timer", args: { minutes: Number(timerAlt[1]) } };

  // Volume — numeric only: "volume N" / "set (the )?volume to N" (0-100).
  const volume = t.match(/^(?:set (?:the )?volume to|volume)\s+(\d{1,3})$/);
  if (volume) {
    const level = Number(volume[1]);
    if (level >= 0 && level <= 100) return { kind: "system", verb: "volume", args: { level } };
  }

  // Mute/unmute the AUDIO (bare "mute" is quiet-mode, handled above): only fires
  // with an explicit audio object — "mute the volume" / "mute the audio".
  if (/^(?:mute (?:the )?(?:volume|audio|sound))$/.test(t)) {
    return { kind: "system", verb: "mute", args: { on: true } };
  }
  if (/^(?:unmute(?: the)?(?: volume| audio| sound)?)$/.test(t)) {
    return { kind: "system", verb: "mute", args: { on: false } };
  }

  // Media transport — MUST precede macroPlay so "play"/"pause" aren't swallowed.
  if (/^(?:pause(?: the)?(?: music| song| track| audio| video)?|play(?: the)?(?: music| song| track| audio)?|resume(?: the)?(?: music| song| track| audio)?)$/.test(t)) {
    return { kind: "system", verb: "mediaPlayPause", args: {} };
  }
  if (/^(?:next(?: track| song)?|skip(?: this)?(?: track| song)?|skip)$/.test(t)) {
    return { kind: "system", verb: "mediaNext", args: {} };
  }
  if (/^(?:previous(?: track| song)?|last song|go back a song|previous)$/.test(t)) {
    return { kind: "system", verb: "mediaPrev", args: {} };
  }

  // Open app — a SHORT 1-2 word app name only, so "open the pod bay doors"
  // (3 words) falls through to a normal turn. Strip a leading "the"/"my".
  const openApp = t.match(/^open\s+(?:the\s+|my\s+)?([a-z][a-z0-9]*(?:\s+[a-z][a-z0-9]*)?)$/);
  if (openApp) {
    const name = openApp[1]
      .split(/\s+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
    return { kind: "system", verb: "openApp", args: { name } };
  }

  // Reminder: "remind me to <text>". Note normalize() has stripped the wake word
  // and "please", so the captured text is clean.
  const reminder = t.match(/^remind me to\s+(.+)$/);
  if (reminder && reminder[1].trim()) {
    return { kind: "system", verb: "reminder", args: { text: reminder[1].trim() } };
  }

  // macros (teach-by-demonstration). Record: "watch this [as <name>]".
  const macroRec = t.match(
    /^(?:watch this|record (?:a )?(?:macro|routine))(?:\s+(?:as|called|named|and call it)\s+(.+))?$/
  );
  if (macroRec) return { kind: "macroRecord", name: (macroRec[1] || "quicksave").trim() };
  if (/^(?:stop watching|stop recording|save (?:the |that )?(?:macro|routine|recording))$/.test(t)) {
    return { kind: "macroStop" };
  }
  if (/^(?:what can you do|list (?:macros|routines)|what (?:macros|routines) do you have)$/.test(t)) {
    return { kind: "macroList" };
  }
  // Play: "run/play/do [the] <name> [macro|routine]". Resolved against saved
  // macros; if none matches, the handler returns null and it falls through.
  const macroPlay = t.match(/^(?:run|play|do)\s+(?:the\s+)?(.+?)(?:\s+(?:macro|routine))?$/);
  if (macroPlay) return { kind: "macroPlay", name: macroPlay[1].trim() };

  // spawn: "spawn|open|create|start|launch a claude|codex [code] agent [named X]"
  const spawn = t.match(
    /^(?:spawn|open|create|start|launch)\s+(?:a|an)\s+(claude|codex|gpt|openai)\s+(?:code\s+)?agent(?:\s+(?:named|called)\s+([a-z][a-z0-9-]*))?$/
  );
  if (spawn) {
    const p = spawn[1] === "codex" || spawn[1] === "gpt" || spawn[1] === "openai" ? "codex" : "claude";
    return { kind: "spawn", provider: p, name: spawn[2] };
  }

  // close: "close [agent] X". The word "agent" is optional — mislabeling is
  // safe because the handler falls through to a normal turn when the captured
  // name isn't a live agent ("close the browser" → findByName("browser") →
  // null → ordinary Vidi turn).
  const close = t.match(
    /^(?:close|dismiss|remove|retire)\s+(?:the\s+)?(?:agent\s+)?([a-z][a-z0-9-]*)$/
  );
  if (close) return { kind: "close", name: close[1] };

  // ask/tell/have: "ask|tell|have X [to] <task>" — task is free text.
  const ask = t.match(/^(?:ask|tell|have)\s+([a-z][a-z0-9-]*)\s+(?:to\s+)?(.+)$/);
  if (ask) return { kind: "ask", name: ask[1], task: ask[2] };

  return null;
}

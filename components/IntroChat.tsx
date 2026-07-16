"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { usePersonaName } from "@/components/usePersonaName";

interface IntroMessage {
  role: "user" | "assistant";
  text: string;
  ts: number;
}

/**
 * Onboarding intro chat (T2.2). A focused first-conversation surface shown right
 * after the 4-step onboarding flow completes (not in replay). It:
 *   - loads the dedicated "intro" thread (deterministic greeting already seeded
 *     server-side, no model call to render it),
 *   - offers the five starter prompts as tappable cards that send the prompt.
 *
 * User replies ride the normal /api/chat SSE pipeline on the intro thread, so
 * the model engages only when the user actually says something. "Start using
 * Vidi" (onDone) leaves the intro for the main chat at any time. Vidi's identity
 * is fixed (product ruling 2026-07-05) — the intro never asks to be renamed.
 */
export default function IntroChat({ onDone }: { onDone: () => void }) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<IntroMessage[]>([]);
  const [starters, setStarters] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  // Live persona name: a customized install greets as "Anna", not the brand.
  const assistantName = usePersonaName();
  const bottomRef = useRef<HTMLDivElement>(null);
  const monogram = (assistantName[0] || "V").toUpperCase();

  useEffect(() => {
    let cancelled = false;
    fetch("/api/onboarding/intro")
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j.thread) {
          setThreadId(j.thread.id);
          setMessages(j.thread.messages || []);
        }
        setStarters(Array.isArray(j.starters) ? j.starters : []);
      })
      .catch(() => {
        // Fail-open: if the intro can't load, don't trap the user here.
        if (!cancelled) onDone();
      });
    return () => {
      cancelled = true;
    };
  }, [onDone]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamText]);

  const sendMessage = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || !threadId || streaming) return;
      setInput("");
      setMessages((m) => [...m, { role: "user", text: message, ts: Date.now() }]);

      setStreaming(true);
      setStreamText("");
      let acc = "";
      try {
        const r = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ threadId, message, provider: "claude", model: "auto", mode: "plan" }),
        });
        if (!r.ok || !r.body) throw new Error(`request failed (${r.status})`);
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() || "";
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data: ")) continue;
            let ev: any;
            try {
              ev = JSON.parse(line.slice(6));
            } catch {
              continue;
            }
            if (ev.type === "delta") {
              acc += ev.text;
              setStreamText(acc);
            } else if (ev.type === "done") {
              acc = ev.fullText || acc;
            } else if (ev.type === "error") {
              acc = ev.message || "Something went wrong. Try again in a moment.";
            }
          }
        }
      } catch {
        acc = acc || "I couldn't reach my brain just now. Try again in a moment.";
      } finally {
        setMessages((m) => [...m, { role: "assistant", text: acc || "(no reply)", ts: Date.now() }]);
        setStreamText("");
        setStreaming(false);
      }
    },
    [threadId, streaming]
  );

  return (
    <div className="onb-backdrop">
      <div className="onb-card intro-card">
        <div className="intro-head">
          <div className="mini-monogram">{monogram}</div>
          <div className="intro-head-name">{assistantName}</div>
          <button
            className="onb-btn onb-btn-skip intro-skip"
            onClick={() => {
              // Skip-and-defer (T2.4): file the intro to the checklist so it
              // resurfaces in Settings, then leave for the main chat.
              fetch("/api/onboarding/deferred", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "defer", step: "intro" }),
              }).catch(() => {});
              onDone();
            }}
          >
            Skip for now
          </button>
          <button className="onb-btn onb-btn-primary intro-done" onClick={onDone}>
            Start using {assistantName}
          </button>
        </div>

        <div className="intro-messages">
          {messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="msg-user">
                {m.text}
              </div>
            ) : (
              <div key={i} className="msg-vidi">
                <div className="mini-monogram">{monogram}</div>
                <div className="msg-vidi-body">
                  <div className="md">
                    <ReactMarkdown>{m.text}</ReactMarkdown>
                  </div>
                </div>
              </div>
            )
          )}
          {streaming && (
            <div className="msg-vidi">
              <div className="mini-monogram">{monogram}</div>
              <div className="msg-vidi-body">
                <div className="md">
                  {streamText ? (
                    <ReactMarkdown>{streamText}</ReactMarkdown>
                  ) : (
                    <span className="thinking">thinking…</span>
                  )}
                </div>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {starters.length > 0 && (
          <div className="intro-starters">
            <div className="intro-starters-label">Or try one of these:</div>
            <div className="intro-starter-cards">
              {starters.map((prompt) => (
                <button
                  key={prompt}
                  className="intro-starter-card"
                  disabled={streaming}
                  onClick={() => sendMessage(prompt)}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="intro-composer">
          <input
            className="onb-input"
            autoFocus
            value={input}
            placeholder={`Message ${assistantName}…`}
            disabled={streaming}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && input.trim()) sendMessage(input);
            }}
          />
          <button
            className="onb-btn onb-btn-primary"
            disabled={streaming || !input.trim()}
            onClick={() => sendMessage(input)}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

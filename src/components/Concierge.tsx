import { useEffect, useRef, useState, type ReactNode } from "react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useChat } from "@ai-sdk/react";
import {
  ArrowUp,
  CornerDownLeft,
  Lock,
  MessageSquare,
  Sparkles,
  Square,
  WifiOff,
  X,
} from "lucide-react";
import { useApp } from "../store.tsx";
import { api } from "../lib/api.ts";
import { Drawer, Spinner } from "./ui.tsx";
import { GarlicGlyph } from "./brand.tsx";

const SUGGESTIONS = [
  "What renews in the next 14 days?",
  "Where can I save money?",
  "What do I spend a month?",
  "Which plan is dormant?",
];

function Message({
  role,
  children,
  pending = false,
}: {
  role: "user" | "assistant";
  children: ReactNode;
  pending?: boolean;
}) {
  if (role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[86%] border border-line bg-raised px-3.5 py-2.5 text-[12px] leading-relaxed text-bone">
          {children}
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-2.5">
      <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border border-blood/30 bg-blood/[0.07] text-blood">
        <GarlicGlyph size={13} />
      </span>
      <div className={`min-w-0 flex-1 text-[12px] leading-relaxed ${pending ? "text-faint" : "text-muted"}`}>
        {children}
      </div>
    </div>
  );
}

function TextBody({ text }: { text: string }) {
  return <div className="whitespace-pre-wrap break-words">{text}</div>;
}

function Composer({
  value,
  onChange,
  onSend,
  disabled,
  onStop,
  busy,
}: {
  value: string;
  onChange: (next: string) => void;
  onSend: () => void;
  disabled: boolean;
  onStop?: () => void;
  busy: boolean;
}) {
  return (
    <div className="border-t border-line-soft px-4 py-3">
      <div className="border border-line bg-ink">
        <textarea
          className="max-h-32 min-h-[44px] w-full resize-none bg-transparent px-3 py-2.5 text-[12px] leading-relaxed text-bone outline-none placeholder:text-faint"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (!disabled) onSend();
            }
          }}
          placeholder="Ask about renewals, spend, or a specific plan…"
          rows={2}
          aria-label="Message the concierge"
        />
        <div className="flex items-center justify-between border-t border-line-soft px-2 py-1.5">
          <span className="flex items-center gap-1.5 font-mono text-[8px] uppercase tracking-[0.1em] text-faint">
            <CornerDownLeft size={9} />
            enter to send · shift+enter for a line
          </span>
          {busy && onStop ? (
            <button type="button" className="btn h-6 px-2 text-[10px]" onClick={onStop}>
              <Square size={9} />
              Stop
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary h-6 px-2 text-[10px]"
              onClick={onSend}
              disabled={disabled || value.trim().length === 0}
            >
              <ArrowUp size={10} />
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function LocalChat() {
  const [messages, setMessages] = useState<Array<{ id: number; role: "user" | "assistant"; text: string }>>([
    {
      id: 0,
      role: "assistant",
      text: "I read the local ledger directly. Ask about renewals, monthly spend, dormant plans, or a specific subscription. I can draft a cancellation plan, but only you can authorize one.",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const counter = useRef(1);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, loading]);

  const ask = async (question: string) => {
    const trimmed = question.trim();
    if (trimmed.length === 0 || loading) return;
    const id = counter.current++;
    setMessages((current) => [...current, { id, role: "user", text: trimmed }]);
    setInput("");
    setLoading(true);
    try {
      const result = await api<{ answer: string; source: "local" }>("/api/ai/ask", {
        method: "POST",
        body: JSON.stringify({ question: trimmed }),
      });
      setMessages((current) => [...current, { id: counter.current++, role: "assistant", text: result.answer }]);
    } catch (cause) {
      setMessages((current) => [
        ...current,
        {
          id: counter.current++,
          role: "assistant",
          text: cause instanceof Error ? `I could not read the ledger: ${cause.message}` : "I could not read the ledger.",
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <div className="flex flex-wrap gap-1.5 border-b border-line-soft px-4 py-2.5">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            className="chip border-line text-muted transition-colors hover:border-line-strong hover:text-bone"
            onClick={() => void ask(suggestion)}
            disabled={loading}
          >
            {suggestion}
          </button>
        ))}
      </div>

      <div ref={scroller} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {messages.map((message) => (
          <Message key={message.id} role={message.role}>
            <TextBody text={message.text} />
          </Message>
        ))}
        {loading ? (
          <Message role="assistant" pending>
            <span className="inline-flex items-center gap-2">
              <Spinner />
              Reading the ledger…
            </span>
          </Message>
        ) : null}
      </div>

      <Composer
        value={input}
        onChange={setInput}
        onSend={() => void ask(input)}
        disabled={loading || input.trim().length === 0}
        busy={loading}
      />
    </>
  );
}

function ModelChat({ label }: { label: string }) {
  const { messages, sendMessage, status, error, stop } = useChat({
    transport: new DefaultChatTransport({ api: "/api/ai/chat" }),
  });
  const [input, setInput] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, status]);

  const send = (text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || busy) return;
    setInput("");
    void sendMessage({ text: trimmed });
  };

  return (
    <>
      <div className="flex flex-wrap gap-1.5 border-b border-line-soft px-4 py-2.5">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            className="chip border-line text-muted transition-colors hover:border-line-strong hover:text-bone"
            onClick={() => send(suggestion)}
            disabled={busy}
          >
            {suggestion}
          </button>
        ))}
      </div>

      <div ref={scroller} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <Message role="assistant">
            <p>
              I can query the ledger with tools and explain what I find. I cannot cancel anything — that always requires
              your typed authorization on the plan page.
            </p>
            <p className="mt-2 font-mono text-[8px] uppercase tracking-[0.1em] text-faint">{label}</p>
          </Message>
        ) : null}

        {messages.map((message: UIMessage) => (
          <Message key={message.id} role={message.role === "user" ? "user" : "assistant"}>
            <div className="space-y-2">
              {message.parts.map((part, index) => {
                if (part.type === "text") {
                  return <TextBody key={index} text={part.text} />;
                }
                if (part.type === "dynamic-tool") {
                  return (
                    <span key={index} className="chip border-line text-faint">
                      tool · {part.toolName}
                    </span>
                  );
                }
                if (part.type.startsWith("tool-")) {
                  return (
                    <span key={index} className="chip border-line text-faint">
                      tool · {part.type.slice(5)}
                    </span>
                  );
                }
                return null;
              })}
            </div>
          </Message>
        ))}

        {status === "submitted" ? (
          <Message role="assistant" pending>
            <span className="inline-flex items-center gap-2">
              <Spinner />
              Thinking…
            </span>
          </Message>
        ) : null}

        {error ? (
          <Message role="assistant">
            <span className="text-blood">The model call failed: {error.message}</span>
          </Message>
        ) : null}
      </div>

      <Composer
        value={input}
        onChange={setInput}
        onSend={() => send(input)}
        disabled={busy || input.trim().length === 0}
        busy={busy}
        onStop={() => stop()}
      />
    </>
  );
}

export function Concierge() {
  const { conciergeOpen, setConciergeOpen, state } = useApp();
  const ai = state?.ai;
  const modelReady = Boolean(ai?.configured && ai.enabled);
  const close = () => setConciergeOpen(false);

  return (
    <Drawer open={conciergeOpen} onClose={close} label="Garlic concierge" width="480px">
      <header className="flex items-start justify-between gap-3 border-b border-line-soft px-4 py-4">
        <div className="flex items-center gap-2.5">
          <span className="text-blood">
            <GarlicGlyph size={22} />
          </span>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-serif text-[22px] italic leading-none text-bone">Concierge</span>
              <span className={`chip ${modelReady ? "border-acid/30 text-acid" : "border-line text-faint"}`}>
                {modelReady ? `${ai?.provider}/${ai?.model}` : "local rules"}
              </span>
            </div>
            <div className="mt-1 font-mono text-[8px] uppercase tracking-[0.14em] text-faint">
              {modelReady ? "reads the ledger through tools" : "answers without a network call"}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={close}
          className="mt-1 text-faint transition-colors hover:text-bone"
          aria-label="Close concierge"
        >
          <X size={16} />
        </button>
      </header>

      {modelReady ? <ModelChat label={`${ai?.provider ?? "model"}/${ai?.model ?? "unknown"}`} /> : <LocalChat />}

      <footer className="space-y-2 border-t border-line-soft px-4 py-3">
        <div className="flex items-center gap-1.5 font-mono text-[8px] uppercase leading-relaxed tracking-[0.1em] text-faint">
          {modelReady ? <Sparkles size={9} /> : <WifiOff size={9} />}
          {modelReady
            ? "redacted context only · raw descriptors never sent"
            : "no model key configured · nothing leaves this device"}
        </div>
        <div className="flex items-start gap-1.5 font-mono text-[8px] uppercase leading-relaxed tracking-[0.1em] text-faint">
          <Lock size={9} className="mt-[1px] shrink-0" />
          the concierge cannot cancel · authorization happens on the plan page
        </div>
        <div className="flex items-center gap-3 border-t border-line-soft pt-2 font-mono text-[8px] uppercase tracking-[0.1em] text-faint">
          <span className="inline-flex items-center gap-1">
            <MessageSquare size={9} />
            {modelReady ? "streaming" : "local rules"}
          </span>
        </div>
      </footer>
    </Drawer>
  );
}

import { useState, useRef, useCallback, memo, useEffect } from "react";

interface ChatInputProps {
  isStreaming: boolean;
  onSend: (text: string) => void;
  onCancel: () => void;
  serverId?: string;
}

export default memo(function ChatInput({
  isStreaming,
  onSend,
  onCancel,
  serverId,
}: ChatInputProps) {
  const draftKey = serverId
    ? `claude-remote-draft-${serverId}`
    : "claude-remote-draft";
  const [input, setInputRaw] = useState(
    () => localStorage.getItem(draftKey) || "",
  );
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setInput = useCallback(
    (v: string) => {
      setInputRaw(v);
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
      draftTimerRef.current = setTimeout(() => {
        if (v) localStorage.setItem(draftKey, v);
        else localStorage.removeItem(draftKey);
      }, 500);
    },
    [draftKey],
  );

  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea to fit content
  const autoResize = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 150) + "px";
  }, []);

  // On touch devices, intercept the tap and focus with preventScroll
  // to stop the browser from scrolling the visual viewport (which causes
  // the header to jump up for a frame before our JS corrects it).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      if (document.activeElement === el) return; // already focused
      e.preventDefault();
      el.focus({ preventScroll: true });
    };
    el.addEventListener("pointerdown", onPointerDown);
    return () => el.removeEventListener("pointerdown", onPointerDown);
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isStreaming) return;
    const text = input.trim();
    setInput("");
    // Reset textarea height after clearing
    requestAnimationFrame(() => {
      if (inputRef.current) {
        inputRef.current.style.height = "auto";
      }
    });
    onSend(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex gap-2 items-end">
      <textarea
        ref={inputRef}
        value={input}
        onChange={(e) => {
          setInput(e.target.value);
          autoResize();
        }}
        onKeyDown={handleKeyDown}
        placeholder={isStreaming ? "Task running..." : "New task..."}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        rows={1}
        className="flex-1 min-h-[44px] max-h-[150px] px-4 py-3 bg-[var(--color-bg-secondary)] rounded-2xl focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] text-base resize-none"
      />
      {isStreaming ? (
        <button
          type="button"
          onClick={onCancel}
          className="min-w-[44px] min-h-[44px] flex items-center justify-center bg-red-600 rounded-full font-semibold hover:bg-red-700 active:bg-red-800 transition-colors"
          aria-label="Cancel"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-5 w-5"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zM8 7a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1V8a1 1 0 00-1-1H8z"
              clipRule="evenodd"
            />
          </svg>
        </button>
      ) : (
        <button
          type="submit"
          disabled={!input.trim()}
          className="min-w-[44px] min-h-[44px] flex items-center justify-center bg-[var(--color-accent)] rounded-full font-semibold hover:bg-[var(--color-accent-hover)] active:bg-[#a04e30] transition-colors disabled:opacity-50 disabled:hover:bg-[var(--color-accent)]"
          aria-label="Send"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-5 w-5"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
          </svg>
        </button>
      )}
    </form>
  );
});

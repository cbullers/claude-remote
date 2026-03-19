import { useState, useCallback } from "react";

interface QuestionOption {
  label: string;
  description?: string;
}

interface Question {
  question: string;
  header?: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
}

interface Props {
  questions: Question[];
  onAnswer: (answers: Array<{ header: string; answer: string }>) => void;
  onDismiss: () => void;
}

export default function AskUserQuestionCard({
  questions,
  onAnswer,
  onDismiss,
}: Props) {
  // Per-question state: selected option indices or custom text
  const [selections, setSelections] = useState<Map<number, Set<number>>>(
    new Map(),
  );
  const [customTexts, setCustomTexts] = useState<Map<number, string>>(
    new Map(),
  );
  const [usingCustom, setUsingCustom] = useState<Set<number>>(new Set());

  const toggleOption = useCallback(
    (qIdx: number, optIdx: number, multiSelect: boolean) => {
      setSelections((prev) => {
        const next = new Map(prev);
        const current = next.get(qIdx) || new Set();
        if (multiSelect) {
          const updated = new Set(current);
          if (updated.has(optIdx)) updated.delete(optIdx);
          else updated.add(optIdx);
          next.set(qIdx, updated);
        } else {
          next.set(qIdx, new Set([optIdx]));
        }
        return next;
      });
      // Clear custom if selecting an option
      setUsingCustom((prev) => {
        const next = new Set(prev);
        next.delete(qIdx);
        return next;
      });
    },
    [],
  );

  const setCustom = useCallback((qIdx: number, text: string) => {
    setCustomTexts((prev) => new Map(prev).set(qIdx, text));
    setUsingCustom((prev) => new Set(prev).add(qIdx));
    setSelections((prev) => {
      const next = new Map(prev);
      next.delete(qIdx);
      return next;
    });
  }, []);

  const canSubmit = questions.every((q, qIdx) => {
    if (usingCustom.has(qIdx))
      return (customTexts.get(qIdx) || "").trim().length > 0;
    const sel = selections.get(qIdx);
    return sel && sel.size > 0;
  });

  const handleSubmit = useCallback(() => {
    const answers = questions.map((q, qIdx) => {
      const header = q.header || `Question ${qIdx + 1}`;
      if (usingCustom.has(qIdx)) {
        return { header, answer: customTexts.get(qIdx) || "" };
      }
      const sel = selections.get(qIdx) || new Set();
      const selectedLabels = (q.options || [])
        .filter((_, i) => sel.has(i))
        .map((o) => o.label);
      return { header, answer: selectedLabels.join(", ") };
    });
    onAnswer(answers);
  }, [questions, selections, customTexts, usingCustom, onAnswer]);

  return (
    <div className="mx-2 mb-4 rounded-lg border border-pink-500/50 bg-pink-950/20 overflow-hidden">
      <div className="px-4 py-3 border-b border-pink-500/30 flex items-center gap-2">
        <span className="text-pink-400 text-lg">❓</span>
        <span className="text-[var(--color-text-primary)] font-medium text-sm">
          Claude is asking you a question
        </span>
      </div>

      <div className="p-4 space-y-6">
        {questions.map((q, qIdx) => (
          <div key={qIdx} className="space-y-3">
            {q.header && (
              <div className="text-xs font-medium text-pink-400 uppercase tracking-wider">
                {q.header}
              </div>
            )}
            <div className="text-[var(--color-text-primary)] text-sm">
              {q.question}
            </div>

            {q.options && q.options.length > 0 && (
              <div className="space-y-2">
                {q.options.map((opt, optIdx) => {
                  const isSelected =
                    !usingCustom.has(qIdx) &&
                    (selections.get(qIdx) || new Set()).has(optIdx);
                  return (
                    <button
                      key={optIdx}
                      onClick={() =>
                        toggleOption(qIdx, optIdx, q.multiSelect || false)
                      }
                      className={`w-full text-left p-3 rounded-md border transition-all ${
                        isSelected
                          ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10 ring-1 ring-[var(--color-accent)]"
                          : "border-[var(--color-border)] bg-[var(--color-bg-secondary)] hover:border-[var(--color-text-secondary)]"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <div
                          className={`w-4 h-4 rounded-${q.multiSelect ? "sm" : "full"} border-2 flex items-center justify-center flex-shrink-0 ${
                            isSelected
                              ? "border-[var(--color-accent)] bg-[var(--color-accent)]"
                              : "border-[var(--color-text-secondary)]"
                          }`}
                        >
                          {isSelected && (
                            <svg
                              className="w-2.5 h-2.5 text-white"
                              fill="currentColor"
                              viewBox="0 0 20 20"
                            >
                              <path d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" />
                            </svg>
                          )}
                        </div>
                        <div>
                          <div className="text-sm font-medium text-[var(--color-text-primary)]">
                            {opt.label}
                          </div>
                          {opt.description && (
                            <div className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                              {opt.description}
                            </div>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}

                {/* Other / custom text option */}
                <button
                  onClick={() => setCustom(qIdx, customTexts.get(qIdx) || "")}
                  className={`w-full text-left p-3 rounded-md border transition-all ${
                    usingCustom.has(qIdx)
                      ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10 ring-1 ring-[var(--color-accent)]"
                      : "border-[var(--color-border)] bg-[var(--color-bg-secondary)] hover:border-[var(--color-text-secondary)]"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <div
                      className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                        usingCustom.has(qIdx)
                          ? "border-[var(--color-accent)] bg-[var(--color-accent)]"
                          : "border-[var(--color-text-secondary)]"
                      }`}
                    >
                      {usingCustom.has(qIdx) && (
                        <svg
                          className="w-2.5 h-2.5 text-white"
                          fill="currentColor"
                          viewBox="0 0 20 20"
                        >
                          <path d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" />
                        </svg>
                      )}
                    </div>
                    <div className="text-sm font-medium text-[var(--color-text-primary)]">
                      Other
                    </div>
                  </div>
                </button>

                {usingCustom.has(qIdx) && (
                  <input
                    type="text"
                    autoFocus
                    value={customTexts.get(qIdx) || ""}
                    onChange={(e) => setCustom(qIdx, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && canSubmit) handleSubmit();
                    }}
                    placeholder="Type your answer..."
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    className="w-full p-3 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-primary)] text-sm placeholder:text-[var(--color-text-secondary)] focus:outline-none focus:border-[var(--color-accent)]"
                  />
                )}
              </div>
            )}

            {/* No options — free text only */}
            {(!q.options || q.options.length === 0) && (
              <input
                type="text"
                autoFocus
                value={customTexts.get(qIdx) || ""}
                onChange={(e) => {
                  setCustomTexts((prev) =>
                    new Map(prev).set(qIdx, e.target.value),
                  );
                  setUsingCustom((prev) => new Set(prev).add(qIdx));
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canSubmit) handleSubmit();
                }}
                placeholder="Type your answer..."
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                className="w-full p-3 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-primary)] text-sm placeholder:text-[var(--color-text-secondary)] focus:outline-none focus:border-[var(--color-accent)]"
              />
            )}
          </div>
        ))}
      </div>

      <div className="px-4 py-3 border-t border-pink-500/30 flex gap-2 justify-end">
        <button
          onClick={onDismiss}
          className="px-4 py-2 rounded-md text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
        >
          Skip
        </button>
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="px-4 py-2 rounded-md text-sm font-medium text-white bg-[var(--color-accent)] hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
        >
          Submit Answer
        </button>
      </div>
    </div>
  );
}

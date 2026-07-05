import { useMemo, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  ListChecks,
  MessageSquarePlus,
  PencilLine,
  Star
} from "lucide-react";
import { cn } from "../../lib/utils";

type AskUserOption = {
  label: string;
  description?: string;
  preview?: string;
  defaultOption?: boolean;
};

type AskUserQuestion = {
  question: string;
  header: string;
  options: AskUserOption[];
  multiSelect: boolean;
};

const OTHER_LABEL_PATTERN = /^(other|not listed|something else|different|else)/i;
const THINK_TAG_PATTERN = /<(thinking|think)>[\s\S]*?<\/\1>/gi;

function cleanLabel(value: string) {
  return value.replace(THINK_TAG_PATTERN, " ").replace(/\s+/g, " ").trim();
}

function formatAnswers(questions: AskUserQuestion[], answers: AnswerMap[]): string {
  const lines: string[] = [];
  questions.forEach((q, index) => {
    const answer = answers[index];
    if (!answer) return;
    const parts: string[] = [];
    answer.presetLabels.forEach((label) => parts.push(label));
    if (answer.customValue.trim()) parts.push(answer.customValue.trim());
    if (parts.length === 0) return;
    lines.push(`Q${index + 1} (${q.header}): ${parts.join(", ")}`);
  });
  return lines.join("\n");
}

type AnswerMap = {
  selectedIndexes: Set<number>;
  customValue: string;
  presetLabels: string[];
};

function buildInitialAnswers(questions: AskUserQuestion[]): AnswerMap[] {
  return questions.map((q) => {
    // Pre-select the option marked as defaultOption (if any)
    const defaultIdx = q.options.findIndex((opt) => opt.defaultOption === true);
    const selected = defaultIdx >= 0 ? new Set<number>([defaultIdx]) : new Set<number>();
    const presetLabels = defaultIdx >= 0
      ? collectPresetLabels(q, selected, -1)
      : [];
    return { selectedIndexes: selected, customValue: "", presetLabels };
  });
}

function collectPresetLabels(question: AskUserQuestion, selectedIndexes: Set<number>, otherIndex: number): string[] {
  const labels: string[] = [];
  selectedIndexes.forEach((idx) => {
    if (idx === otherIndex) return;
    const option = question.options[idx];
    if (option) labels.push(cleanLabel(option.label));
  });
  return labels;
}

export function InteractiveOptions({
  questions,
  onSubmit
}: {
  questions: AskUserQuestion[];
  onSubmit: (response: string) => void;
}) {
  const [answers, setAnswers] = useState<AnswerMap[]>(() => buildInitialAnswers(questions));
  const [expandedPreview, setExpandedPreview] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  // Memoize per-question derived state (other option index, total count, etc.)
  const derived = useMemo(
    () => questions.map((q) => {
      const otherIndex = q.options.findIndex((opt) => OTHER_LABEL_PATTERN.test(cleanLabel(opt.label)));
      return { otherIndex };
    }),
    [questions]
  );

  if (questions.length === 0) return null;

  const submit = (nextAnswers: AnswerMap[]) => {
    if (submitted) return; // Prevent duplicate submissions
    const response = formatAnswers(questions, nextAnswers);
    if (response.trim().length === 0) return;
    setSubmitted(true);
    onSubmit(response);
  };

  const handleToggle = (questionIndex: number, optionIndex: number) => {
    if (submitted) return; // Prevent any interaction after submission

    const question = questions[questionIndex];
    const { otherIndex } = derived[questionIndex];
    const current = answers[questionIndex];
    const isOther = optionIndex === otherIndex;

    if (!question.multiSelect) {
      const nextAnswers = answers.map((entry, idx) => {
        if (idx !== questionIndex) return entry;
        const selected = new Set<number>([optionIndex]);
        return {
          ...entry,
          selectedIndexes: selected,
          customValue: isOther ? entry.customValue : "",
          presetLabels: collectPresetLabels(question, selected, otherIndex)
        };
      });

      setAnswers(nextAnswers);

      // Auto-submit only if it's the only question and not "other"
      if (questions.length === 1 && !isOther) {
        submit(nextAnswers);
      }
      return;
    }

    // Multi-select: toggle membership
    const next = new Set(current.selectedIndexes);
    if (next.has(optionIndex)) {
      next.delete(optionIndex);
    } else {
      next.add(optionIndex);
    }
    setAnswers((prev) => prev.map((entry, idx) => {
      if (idx !== questionIndex) return entry;
      return {
        ...entry,
        selectedIndexes: next,
        customValue: !isOther || next.has(optionIndex) ? entry.customValue : "",
        presetLabels: collectPresetLabels(question, next, otherIndex)
      };
    }));
  };

  const handleCustomValueChange = (questionIndex: number, value: string) => {
    setAnswers((prev) => prev.map((entry, idx) => idx === questionIndex ? { ...entry, customValue: value } : entry));
  };

  const handleSingleOtherSubmit = (questionIndex: number) => {
    const trimmed = answers[questionIndex].customValue.trim();
    if (!trimmed) return;
    submit(answers);
  };

  const handleMultiSubmit = () => {
    submit(answers);
  };

  const previewKey = (questionIndex: number, optionIndex: number) => `${questionIndex}:${optionIndex}`;

  const togglePreview = (key: string) => {
    setExpandedPreview((current) => (current === key ? null : key));
  };

  const allQuestionsAnswered = questions.every((q, idx) => {
    const answer = answers[idx];
    if (!answer) return false;
    return answer.selectedIndexes.size > 0 || answer.customValue.trim().length > 0;
  });

  return (
    <section
      aria-label="Interactive answer options"
      className="my-2 overflow-hidden rounded border border-border/40 bg-card-3/40"
      style={{ backdropFilter: "blur(16px)" }}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border/30 px-3 py-2">
        <div className="flex items-center gap-2.5">
          <MessageSquarePlus className="h-3 w-3 text-muted-foreground/60" />
          <span className="font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            ask user
          </span>
          <span className="font-mono-tech text-[9px] text-muted-foreground/50">
            {questions.length} {questions.length === 1 ? "question" : "questions"}
          </span>
        </div>
        <div className="font-mono-tech text-[9px] text-muted-foreground/50">
          {questions.some((q) => q.multiSelect) ? "pick + submit" : "click to send"}
        </div>
      </header>

      <div className="space-y-2.5 p-3">
        {questions.map((question, qIndex) => {
          const { otherIndex } = derived[qIndex];
          const answer = answers[qIndex];
          const isOtherSelected = otherIndex >= 0 ? answer.selectedIndexes.has(otherIndex) : false;
          return (
            <div key={`q-${qIndex}-${question.header}`} className="overflow-hidden rounded border border-border/40 bg-card/40" style={{ backdropFilter: "blur(16px)" }}>
              <div className="flex flex-wrap items-center gap-2 border-b border-border/30 px-3 py-2">
                <span className="font-mono-tech text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60">
                  {question.header}
                </span>
                <div className="text-[10px] font-medium text-foreground">
                  {question.question}
                </div>
                {question.multiSelect ? (
                  <span className="ml-auto inline-flex items-center gap-1 font-mono-tech text-[9px] uppercase tracking-[0.12em] text-muted-foreground/50">
                    <ListChecks className="h-2.5 w-2.5" />
                    multi
                  </span>
                ) : null}
              </div>

              <div className="flex flex-col gap-1 p-2">
                {question.options.map((option, oIndex) => {
                  const isSelected = answer.selectedIndexes.has(oIndex);
                  const isOther = oIndex === otherIndex;
                  const key = previewKey(qIndex, oIndex);
                  const previewOpen = expandedPreview === key;
                  const showPreviewToggle = !isOther && typeof option.preview === "string" && option.preview.length > 0;
                  return (
                    <div key={`opt-${qIndex}-${oIndex}-${option.label}`} className="flex flex-col">
                      <button
                        type="button"
                        onClick={() => handleToggle(qIndex, oIndex)}
                        disabled={submitted}
                        className={cn(
                          "group flex w-full items-center justify-between gap-3 rounded border px-2.5 py-2 text-left transition-colors",
                          submitted && "cursor-not-allowed opacity-50",
                          isSelected
                            ? "border-accent-blue/40 bg-accent-blue/10 text-foreground"
                            : "border-border/40 bg-card-3/50 text-foreground hover:border-border hover:bg-card-3/60"
                        )}
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          <div className={cn(
                            "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[2px] border transition-colors",
                            isSelected
                              ? "border-accent-blue bg-accent-blue text-white"
                              : "border-border bg-transparent text-transparent group-hover:border-border"
                          )}>
                            {isSelected ? <Check size={9} strokeWidth={3} /> : null}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-[10px] font-medium text-foreground">
                                {option.label}
                              </span>
                              {option.defaultOption && !isOther && (
                                <span className="inline-flex shrink-0 items-center gap-0.5 rounded border border-accent-yellow/30 bg-accent-yellow/[0.08] px-1 py-px font-mono-tech text-[8px] font-semibold uppercase tracking-[0.1em] text-accent-yellow">
                                  <Star size={7} className="fill-current" />
                                  rec
                                </span>
                              )}
                            </div>
                            {option.description && !isOther && (
                              <div className="mt-0.5 line-clamp-2 text-[10px] leading-4 text-muted-foreground/70">
                                {option.description}
                              </div>
                            )}
                            {isOther && (
                              <div className="mt-0.5 text-[10px] text-muted-foreground/60">
                                Type a custom response instead.
                              </div>
                            )}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {showPreviewToggle && (
                            <span
                              role="button"
                              tabIndex={0}
                              onClick={(event) => {
                                event.stopPropagation();
                                togglePreview(key);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  togglePreview(key);
                                }
                              }}
                              className={cn(
                                "flex items-center gap-1 rounded border border-border/40 bg-card-3 px-1.5 py-0.5 font-mono-tech text-[9px] font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:border-border hover:text-foreground",
                                previewOpen && "border-border text-foreground"
                              )}
                            >
                              {previewOpen ? <ChevronUp size={9} /> : <ChevronDown size={9} />}
                              preview
                            </span>
                          )}
                          <div className={cn(
                            "shrink-0 transition-colors",
                            isSelected ? "text-foreground" : "text-muted-foreground/40 group-hover:text-foreground"
                          )}>
                            {isOther ? <PencilLine size={12} /> : <ArrowRight size={12} />}
                          </div>
                        </div>
                      </button>
                      {showPreviewToggle && previewOpen && option.preview && (
                        <pre className="sidebar-scroll mt-1 overflow-x-auto rounded border border-border/40 bg-card-3/50 px-2.5 py-2 font-mono-tech text-[10px] leading-4 text-muted-foreground">
                          {option.preview}
                        </pre>
                      )}
                    </div>
                  );
                })}
              </div>

              {isOtherSelected && (
                <div className="border-t border-border/30 px-3 py-2.5">
                  <div className="mb-1.5 font-mono-tech text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/50">
                    Custom response
                  </div>
                  <textarea
                    value={answer.customValue}
                    onChange={(event) => handleCustomValueChange(qIndex, event.target.value)}
                    placeholder="Describe what you want..."
                    className="min-h-[64px] w-full resize-y rounded border border-border/40 bg-card-3/50 px-2.5 py-2 font-mono-tech text-[10px] text-foreground placeholder:text-muted-foreground/50 focus:border-border focus:outline-none"
                  />
                  {!question.multiSelect && questions.length === 1 && (
                    <div className="mt-2 flex justify-end">
                      <button
                        type="button"
                        onClick={() => handleSingleOtherSubmit(qIndex)}
                        disabled={!answer.customValue.trim()}
                        className="rounded border border-accent-orange/40 bg-accent-orange px-2.5 py-1 font-mono-tech text-[10px] font-semibold uppercase tracking-[0.12em] text-white transition-colors hover:bg-accent-orange/80 disabled:opacity-40"
                      >
                        Send
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {(questions.some((q) => q.multiSelect) || questions.length > 1) && (
          <div className="flex flex-col gap-2 rounded border border-border/40 bg-card/50 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="font-mono-tech text-[10px] text-muted-foreground/60">
              {submitted
                ? "Answers sent to agent."
                : allQuestionsAnswered
                  ? "All answered — submit to send back to agent."
                  : "Answer all questions, then submit."}
            </div>
            <button
              type="button"
              onClick={handleMultiSubmit}
              disabled={!allQuestionsAnswered || submitted}
              className="rounded border border-accent-orange/40 bg-accent-orange px-2.5 py-1 font-mono-tech text-[10px] font-semibold uppercase tracking-[0.12em] text-white transition-colors hover:bg-accent-orange/80 disabled:opacity-40"
            >
              {submitted ? "Sent" : "Submit"}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

import { useState } from "react";

export function TerminalBlock({ text, title = "저장된 출력" }: { text: string; title?: string }) {
  const [wrap, setWrap] = useState(false);
  const [copyResult, setCopyResult] = useState<{
    text: string;
    state: "copying" | "copied" | "failed";
  } | null>(null);
  const copyState = copyResult?.text === text ? copyResult.state : "idle";
  async function copy() {
    setCopyResult({ text, state: "copying" });
    try {
      await navigator.clipboard.writeText(text);
      setCopyResult({ text, state: "copied" });
    } catch {
      setCopyResult({ text, state: "failed" });
    }
  }
  return (
    <section className="terminal-block" aria-label={title}>
      <div className="terminal-toolbar">
        <span className="terminal-title">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <path d="m5 6 5 6-5 6m8 0h6" />
          </svg>
          {title}
        </span>
        <div className="terminal-controls">
          <button aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
            줄바꿈
          </button>
          <button disabled={copyState === "copying"} onClick={() => void copy()}>
            {copyState === "copying" ? "복사 중" : "복사"}
          </button>
        </div>
      </div>
      <pre
        className={`terminal-output ${wrap ? "is-wrapped" : ""}`}
        tabIndex={0}
        aria-label={`${title} 내용`}
      >
        <code>{text}</code>
      </pre>
      <div className="terminal-footer">
        <span>읽기 전용</span>
        <span role="status">
          {copyState === "copied"
            ? "복사됨"
            : copyState === "failed"
              ? "복사하지 못했습니다. 내용을 직접 선택해 주세요."
              : `${text.split("\n").length}줄`}
        </span>
      </div>
    </section>
  );
}

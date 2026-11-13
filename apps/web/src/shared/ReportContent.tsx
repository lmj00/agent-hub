import { Children, isValidElement, lazy, Suspense } from "react";
import type { Components } from "react-markdown";
import { TerminalBlock } from "./TerminalBlock.js";

const Markdown = lazy(() => import("react-markdown"));

const components: Components = {
  pre({ children }) {
    const code = Children.toArray(children)[0];
    if (!isValidElement<{ children?: string; className?: string }>(code))
      return <pre>{children}</pre>;
    const language = code.props.className?.replace(/^language-/, "");
    return (
      <TerminalBlock
        title={language ? `코드 · ${language}` : "코드"}
        text={String(code.props.children ?? "").replace(/\n$/, "")}
      />
    );
  },
  // Model-provided images must not trigger third-party requests from the owner's browser.
  img({ alt }) {
    return <span className="report-image">{`[이미지${alt ? `: ${alt}` : ""}]`}</span>;
  },
  a({ href, children }) {
    return href ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    );
  },
  h1({ children }) {
    return <h4>{children}</h4>;
  },
  h2({ children }) {
    return <h4>{children}</h4>;
  },
  h3({ children }) {
    return <h4>{children}</h4>;
  },
};

export function ReportContent({ text }: { text: string }) {
  return (
    <div className="analysis-result report-content">
      <Suspense fallback={<p>{text}</p>}>
        <Markdown components={components}>{text}</Markdown>
      </Suspense>
    </div>
  );
}

import React from "react";
import ReactMarkdown from "react-markdown";

/**
 * Heavyweight article-style markdown renderer for project writeups.
 *
 * Used on both the public /projects/<slug> page AND the admin preview pane,
 * so the author sees exactly what a visitor sees while editing.
 *
 * For short, inline rich-text (timeline descriptions, captions), use
 * `MarkdownText` instead — it inherits parent typography and won't
 * dominate the surrounding UI.
 */
export function ProjectArticle({ markdown }: { markdown: string }) {
  return (
    <ReactMarkdown
      components={{
        h1: ({ children }) => (
          <h1 className="text-3xl sm:text-4xl font-medium text-purple dark:text-rose leading-tight mb-6 sm:mb-8">
            {children}
          </h1>
        ),
        h2: ({ children }) => (
          <h2 className="text-xl sm:text-2xl font-medium text-purple dark:text-rose mt-10 sm:mt-12 mb-4">
            {children}
          </h2>
        ),
        h3: ({ children }) => (
          <h3 className="text-base sm:text-lg font-semibold text-purple dark:text-rose mt-6 mb-2">
            {children}
          </h3>
        ),
        p: ({ children }) => (
          <p className="text-base sm:text-[17px] leading-relaxed mb-5">
            {children}
          </p>
        ),
        ul: ({ children }) => (
          <ul className="list-disc pl-6 mb-5 space-y-1.5 text-base sm:text-[17px]">
            {children}
          </ul>
        ),
        ol: ({ children }) => (
          <ol className="list-decimal pl-6 mb-5 space-y-1.5 text-base sm:text-[17px]">
            {children}
          </ol>
        ),
        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
        strong: ({ children }) => (
          <strong className="font-semibold text-purple dark:text-rose">
            {children}
          </strong>
        ),
        em: ({ children }) => <em className="italic">{children}</em>,
        a: ({ href, children }) => (
          <a
            href={href}
            className="underline decoration-purple/30 dark:decoration-rose/30 underline-offset-2 hover:decoration-purple dark:hover:decoration-rose transition-colors"
            target={href?.startsWith("http") ? "_blank" : undefined}
            rel={href?.startsWith("http") ? "noopener noreferrer" : undefined}
          >
            {children}
          </a>
        ),
        code: ({ className, children, ...props }) => {
          const isBlock =
            (className ?? "").includes("language-") ||
            String(children ?? "").includes("\n");
          if (isBlock) {
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          }
          return (
            <code className="px-1.5 py-0.5 rounded bg-purple/10 dark:bg-rose/10 text-[0.92em] font-mono text-purple dark:text-rose">
              {children}
            </code>
          );
        },
        pre: ({ children }) => (
          <pre className="my-6 p-4 rounded-lg bg-darkSurface dark:bg-darkElevated overflow-x-auto text-xs sm:text-[13px] leading-relaxed text-rose/90 font-mono">
            {children}
          </pre>
        ),
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 border-purple/30 dark:border-rose/30 pl-4 my-5 italic text-purple/70 dark:text-rose/70">
            {children}
          </blockquote>
        ),
        hr: () => <hr className="my-10 border-purple/10 dark:border-rose/10" />,
      }}
    >
      {markdown}
    </ReactMarkdown>
  );
}

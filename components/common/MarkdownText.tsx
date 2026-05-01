import React from "react";
import ReactMarkdown from "react-markdown";

/**
 * Inline-friendly markdown renderer.
 *
 * Use for short rich-text fields (timeline descriptions, captions, etc.)
 * where a heavyweight prose renderer would overpower the surrounding UI.
 * For long-form articles, see `pages/projects/[slug].tsx` which has its
 * own component map tuned for article-level layout.
 *
 * Defaults preserve the parent's text size/color so the rendered markdown
 * blends in. Block elements (lists, blockquotes, code blocks) get tight
 * vertical rhythm so the field doesn't visually balloon when the user
 * adds a list to a one-liner description.
 */
export function MarkdownText({
  text,
  className = "",
}: {
  text:       string | null | undefined;
  className?: string;
}) {
  if (!text || !text.trim()) return null;
  return (
    <div className={className}>
      <ReactMarkdown
        components={{
          // Paragraphs blend with parent — only spacing between paragraphs.
          p: ({ children }) => (
            <p className="leading-relaxed [&:not(:last-child)]:mb-2">{children}</p>
          ),
          ul: ({ children }) => (
            <ul className="list-disc pl-5 my-2 space-y-0.5">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal pl-5 my-2 space-y-0.5">{children}</ol>
          ),
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          a: ({ href, children }) => (
            <a
              href={href}
              className="underline decoration-current/40 underline-offset-2 hover:decoration-current transition-colors"
              target={href?.startsWith("http") ? "_blank" : undefined}
              rel={href?.startsWith("http") ? "noopener noreferrer" : undefined}
            >
              {children}
            </a>
          ),
          // Inline code only here. Block-level pre rendered minimally — if
          // someone really pastes a code block in a description, it gets a
          // tight panel instead of the full article-style box.
          code: ({ className, children, ...props }) => {
            const isBlock =
              (className ?? "").includes("language-") ||
              String(children ?? "").includes("\n");
            if (isBlock) {
              return <code className={className} {...props}>{children}</code>;
            }
            return (
              <code className="px-1 py-0.5 rounded bg-current/5 text-[0.92em] font-mono">
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="my-2 p-2 rounded bg-current/5 overflow-x-auto text-[0.85em] font-mono">
              {children}
            </pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-current/30 pl-3 my-2 italic opacity-80">
              {children}
            </blockquote>
          ),
          // Headings shouldn't really appear in descriptions, but if they
          // do, render them as bold text rather than visually disrupting
          // the surrounding layout.
          h1: ({ children }) => <p className="font-semibold mt-3 mb-1">{children}</p>,
          h2: ({ children }) => <p className="font-semibold mt-3 mb-1">{children}</p>,
          h3: ({ children }) => <p className="font-semibold mt-2 mb-1">{children}</p>,
          hr: () => <hr className="my-3 border-current/20" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

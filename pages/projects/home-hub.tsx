import React from "react";
import type { GetStaticProps, NextPage } from "next";
import Head from "next/head";
import NextLink from "next/link";
import fs from "fs";
import path from "path";
import ReactMarkdown from "react-markdown";
import DefaultLayout from "@/layouts/default";

// Read the writeup at build time. Keeping the source as a plain .md file
// (rather than inlined JSX) makes editing it trivial — the file lives at the
// repo root where it was authored. If/when more writeups land, factor this
// into a [slug].tsx + content/projects/*.md folder.
type Props = { markdown: string };

export const getStaticProps: GetStaticProps<Props> = async () => {
  const filePath = path.join(process.cwd(), "home_hub_writeup.md");
  const markdown = fs.readFileSync(filePath, "utf8");
  return { props: { markdown } };
};

const HomeHubWritePage: NextPage<Props> = ({ markdown }) => {
  return (
    <DefaultLayout>
      <Head>
        <title>Home Hub · Gennaro Anesi</title>
        <meta
          name="description"
          content="Building a natural-language home hub with Claude — architecture, the design decision that mattered, and the war stories worth retelling."
        />
      </Head>

      {/* Outer wrapper paints its own bg. Necessary because DefaultLayout's
          wrapper is locked to height:100dvh, and long content overflows past
          that boundary — beyond which the body's bg shows through (and
          something further up the tree is rendering it as black). Painting
          the bg on a div that grows with content keeps the page visually
          consistent regardless of where the body actually ends. */}
      <div className="bg-gray-50 dark:bg-darkBg">
        <article className="px-6 sm:px-10 py-10 sm:py-14 max-w-3xl mx-auto w-full text-purple/90 dark:text-rose/90">
        <div className="mb-8 text-xs">
          <NextLink href="/timeline" className="text-purple/60 dark:text-rose/60 hover:text-purple dark:hover:text-rose transition-colors">
            ← Timeline
          </NextLink>
        </div>

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
            // Inline code AND fenced blocks: react-markdown 9 passes a `inline`
            // prop on the code node — but the typing here is loose so we
            // detect via parent or fall back to className presence.
            code: ({ className, children, ...props }) => {
              const isBlock = (className ?? "").includes("language-") || String(children ?? "").includes("\n");
              if (isBlock) {
                // Block render is handled by `pre`; just pass through.
                return <code className={className} {...props}>{children}</code>;
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
        </article>
      </div>
    </DefaultLayout>
  );
};

export default HomeHubWritePage;

import React from "react";
import type { GetStaticPaths, GetStaticProps, NextPage } from "next";
import Head from "next/head";
import NextLink from "next/link";
import fs from "fs";
import path from "path";
import ReactMarkdown from "react-markdown";
import DefaultLayout from "@/layouts/default";

// Each writeup is a markdown file under content/projects/. The slug is the
// filename minus the .md extension. Drop a new file in that folder and it
// becomes a page at /projects/<slug> on next build, no code changes needed.

const PROJECTS_DIR = path.join(process.cwd(), "content", "projects");

// Per-slug Head metadata. Keeps title/description honest without forcing
// frontmatter on every file. When this list grows past ~5, switch to YAML
// frontmatter parsing instead of hand-maintaining a map here.
const META: Record<string, { title: string; description: string }> = {
  "home-hub": {
    title: "Home Hub",
    description:
      "Building a natural-language home hub with Claude — architecture, the design decision that mattered, and the war stories worth retelling.",
  },
  flying: {
    title: "Flight Log",
    description:
      "Building a 3D flight log site with Claude — Cesium globe, KML routes, FAA chart archive, and video-to-route sync.",
  },
};

type Props = { slug: string; markdown: string };

export const getStaticPaths: GetStaticPaths = async () => {
  const files = fs
    .readdirSync(PROJECTS_DIR)
    .filter((f) => f.endsWith(".md"));
  return {
    paths: files.map((f) => ({ params: { slug: f.replace(/\.md$/, "") } })),
    fallback: false,
  };
};

export const getStaticProps: GetStaticProps<Props> = async ({ params }) => {
  const slug = params!.slug as string;
  const filePath = path.join(PROJECTS_DIR, `${slug}.md`);
  const markdown = fs.readFileSync(filePath, "utf8");
  return { props: { slug, markdown } };
};

const ProjectPage: NextPage<Props> = ({ slug, markdown }) => {
  const meta = META[slug] ?? { title: slug, description: "" };
  return (
    <DefaultLayout>
      <Head>
        <title>{meta.title} · Gennaro Anesi</title>
        <meta name="description" content={meta.description} />
      </Head>

      {/* Outer wrapper paints its own bg. DefaultLayout's wrapper is locked
          to height:100dvh; long content overflows past that boundary, so we
          paint our own bg here to keep the page visually consistent. */}
      <div className="bg-gray-50 dark:bg-darkBg">
        <article className="px-6 sm:px-10 py-10 sm:py-14 max-w-3xl mx-auto w-full text-purple/90 dark:text-rose/90">
          <div className="mb-8 text-xs">
            <NextLink
              href="/timeline"
              className="text-purple/60 dark:text-rose/60 hover:text-purple dark:hover:text-rose transition-colors"
            >
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
              hr: () => (
                <hr className="my-10 border-purple/10 dark:border-rose/10" />
              ),
            }}
          >
            {markdown}
          </ReactMarkdown>
        </article>
      </div>
    </DefaultLayout>
  );
};

export default ProjectPage;

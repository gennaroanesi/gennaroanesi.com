import React, { useEffect, useState } from "react";
import type { NextPage } from "next";
import Head from "next/head";
import NextLink from "next/link";
import { useRouter } from "next/router";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "@/amplify/data/resource";
import DefaultLayout from "@/layouts/default";
import { ProjectArticle } from "@/components/common/ProjectArticle";

// Public reads use the apiKey auth mode — visitors aren't authenticated.
// Source of truth is the projectWriteup model; legacy content/projects/*.md
// files are seeded into the DB once via the admin page and then ignored.
const client = generateClient<Schema>();

type Writeup = Schema["projectWriteup"]["type"];

const ProjectPage: NextPage = () => {
  const router = useRouter();
  const slug = typeof router.query.slug === "string" ? router.query.slug : "";

  const [writeup, setWriteup] = useState<Writeup | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    async function load() {
      try {
        const { data } = await client.models.projectWriteup.get(
          { slug },
          { authMode: "apiKey" },
        );
        if (cancelled) return;
        if (!data || data.published === false) {
          setNotFound(true);
        } else {
          setWriteup(data);
        }
      } catch (err) {
        console.warn("[project] load failed:", err);
        if (!cancelled) setNotFound(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [slug]);

  return (
    <DefaultLayout>
      <Head>
        <title>{(writeup?.title ?? slug) + " · Gennaro Anesi"}</title>
        {writeup?.description && (
          <meta name="description" content={writeup.description} />
        )}
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

          {loading ? (
            <p className="text-sm text-purple/60 dark:text-rose/60 animate-pulse">Loading…</p>
          ) : notFound ? (
            <p className="text-sm text-purple/70 dark:text-rose/70">
              Writeup not found. <NextLink href="/timeline" className="underline">Back to timeline</NextLink>
            </p>
          ) : writeup ? (
            <ProjectArticle markdown={writeup.markdown ?? ""} />
          ) : null}
        </article>
      </div>
    </DefaultLayout>
  );
};

export default ProjectPage;

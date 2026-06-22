import type { NextPage } from "next";
import dynamic from "next/dynamic";
import Head from "next/head";

import { useRequireAuth } from "@/hooks/useRequireAuth";

const QuoteCardGenerator = dynamic(
  () => import("@/components/layoff-philosophy/QuoteCardGenerator"),
  { ssr: false }
);

const LayoffPhilosophyPage: NextPage = () => {
  const { authState } = useRequireAuth("admins");
  if (authState !== "authenticated") return null;

  return (
    <>
      <Head>
        <title>Layoff Philosophy · Quote Card Generator</title>
        <meta
          name="description"
          content="Generate 1080×1080 Instagram quote cards for @layoffphilosophy."
        />
        <link
          rel="preconnect"
          href="https://fonts.googleapis.com"
        />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </Head>
      <QuoteCardGenerator />
    </>
  );
};

export default LayoffPhilosophyPage;

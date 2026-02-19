import React from "react";
import type { NextPage } from "next";
import Head from "next/head";
import dynamic from "next/dynamic";
import { sampleBrief } from "@/components/dispatch/sampleData";

// Dynamic import to avoid SSR issues with CSS module animations
const DispatchBrief = dynamic(
  () => import("@/components/dispatch/DispatchBrief"),
  { ssr: false }
);

const DispatcherPage: NextPage = () => {
  return (
    <>
      <Head>
        <title>DISPATCH · AI Flight Dispatcher</title>
        <meta name="description" content="AI-powered preflight dispatch brief for general aviation pilots." />
      </Head>
      <DispatchBrief data={sampleBrief} />
    </>
  );
};

export default DispatcherPage;

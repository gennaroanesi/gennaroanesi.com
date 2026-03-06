import React from "react";
import type { NextPage } from "next";
import Head from "next/head";
import dynamic from "next/dynamic";
import { sampleBrief } from "@/components/dispatch/sampleData";
import { useRequireAuth } from "@/hooks/useRequireAuth";

const DispatchBrief = dynamic(
  () => import("@/components/dispatch/DispatchBrief"),
  { ssr: false }
);

const DispatcherPage: NextPage = () => {
  const { authState } = useRequireAuth("admins");
  if (authState !== "authenticated") return null;

  return (
    <>
      <Head>
        <title>DISPATCH · AI Flight Dispatcher POC</title>
        <meta name="description" content="AI-powered preflight dispatch brief — UI prototype." />
      </Head>
      <DispatchBrief data={sampleBrief} />
    </>
  );
};

export default DispatcherPage;

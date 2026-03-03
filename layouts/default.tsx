import React, { createContext, useState } from "react";

import { Head } from "./head";
import { Navbar } from "@/components/navbar";

type ContextType = {
  showMessageModal: boolean;
  setShowMessageModal: (value: boolean) => void;
};

export const MessageModalContext = createContext<ContextType>({
  showMessageModal: false,
  setShowMessageModal: () => null,
});

export default function DefaultLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex flex-col bg-gray-50 dark:bg-darkBg" style={{ height: "100dvh" }}>
      <main className="container mx-auto max-w-full flex flex-col" style={{ flex: "1 1 0", minHeight: 0 }}>
        <Head />
        <Navbar />
        {children}
      </main>
    </div>
  );
}

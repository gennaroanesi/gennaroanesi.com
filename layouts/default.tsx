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
    <div className="relative flex flex-col h-dvh">
      <main className="container mx-auto max-w-full flex-grow ">
        <Head />
        <Navbar />
        {children}
      </main>
    </div>
  );
}

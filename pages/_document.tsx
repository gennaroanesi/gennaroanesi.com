import React from "react";
import { Html, Head, Main, NextScript } from "next/document";

export default function Document() {
  return (
    <Html className="fade" lang="en">
      <Head />
      {/* bg-gray-50 / dark:bg-darkBg matches DefaultLayout's wrapper so
          long-scroll content pages don't expose a different body color
          when scrolled past the wrapper's 100dvh height. */}
      <body className="min-h-screen bg-gray-50 dark:bg-darkBg font-sans antialiased">
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}

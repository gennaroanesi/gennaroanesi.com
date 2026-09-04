import React from "react";
import { Html, Head, Main, NextScript } from "next/document";

export default function Document() {
  return (
    <Html className="fade" lang="en">
      <Head>
        {/* Favicons live here (not in layouts/head.tsx) so every page gets them,
            including pages that don't use DefaultLayout. SVG is the crisp
            primary; the small PNGs are fallbacks (the old /favicon.png was
            4146×3586 and browsers refused to render it). */}
        <link href="/favicon.svg" rel="icon" type="image/svg+xml" />
        <link href="/favicon-32.png" rel="icon" type="image/png" sizes="64x64" />
        <link href="/apple-touch-icon.png" rel="apple-touch-icon" />
        {/* Load Adobe Typekit via a parallel <link> instead of a CSS @import in
            globals.css. The @import forced a serial waterfall (fetch+parse
            globals.css → discover @import → fetch Typekit) that blocked first
            paint; preconnect + link fetches it in parallel with the main CSS. */}
        <link href="https://use.typekit.net" rel="preconnect" />
        <link href="https://p.typekit.net" rel="preconnect" crossOrigin="anonymous" />
        <link href="https://use.typekit.net/jmz6tea.css" rel="stylesheet" />
      </Head>
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

import React from "react";
import { Html, Head, Main, NextScript } from "next/document";

export default function Document() {
  return (
    // No next/font here on purpose: the loader does NOT run in _document on the
    // Pages Router, so the variable classes come back as dead strings and no
    // @font-face is emitted — `font-sans` on <body> then resolves an undefined
    // var() and the whole page falls back to the browser's default serif.
    // The fonts are declared in _app.tsx instead.
    <Html className="fade" lang="en">
      <Head>
        {/* Favicons live here (not in layouts/head.tsx) so every page gets them,
            including pages that don't use DefaultLayout. SVG is the crisp
            primary; the small PNGs are fallbacks (the old /favicon.png was
            4146×3586 and browsers refused to render it). */}
        <link href="/favicon.svg" rel="icon" type="image/svg+xml" />
        <link href="/favicon-32.png" rel="icon" type="image/png" sizes="64x64" />
        <link href="/apple-touch-icon.png" rel="apple-touch-icon" />
        {/* Typekit (source-sans-pro) used to be loaded here. It was removed
            because it never actually rendered — see the fontFamily note in
            tailwind.config.js. Fonts are now self-hosted by next/font, which
            emits its own preload links, so there is no third-party request and
            nothing to preconnect to. */}
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

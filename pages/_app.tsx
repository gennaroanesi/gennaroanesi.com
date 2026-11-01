import type { AppProps } from "next/app";

import { HeroUIProvider } from "@heroui/system";
import { ToastProvider } from "@heroui/react";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { useRouter } from "next/router";
import { useCallback } from "react";

import "@/styles/globals.css";

import { fontSans, fontMono } from "@/config/fonts";

import { Amplify } from "aws-amplify";
import outputs from "@/amplify_outputs.json";

Amplify.configure(outputs);

export default function App({ Component, pageProps }: AppProps) {
  const router = useRouter();
  const navigate = useCallback((path: string) => router.push(path), [router]);

  return (
    <NextThemesProvider attribute="class" defaultTheme="dark">
      {/* next/font must be loaded from _app on the Pages Router — that call is
          what emits the @font-face rules and the preload links.

          The variables are forwarded onto :root rather than left on the class
          next/font hands back, because `font-sans` sits on <body>, which is an
          ANCESTOR of everything _app renders: a variable defined on a wrapper
          div inside #__next would be out of scope exactly where it's consumed.
          :root also covers what HeroUI portals onto document.body — toasts and
          modals render outside this tree. */}
      <style jsx global>{`
        :root {
          --font-sans: ${fontSans.style.fontFamily};
          --font-mono: ${fontMono.style.fontFamily};
        }
      `}</style>
      <div>
        <HeroUIProvider navigate={navigate}>
          <ToastProvider placement="bottom-right" toastOffset={12} />
          <Component {...pageProps} />
        </HeroUIProvider>
      </div>
    </NextThemesProvider>
  );
}

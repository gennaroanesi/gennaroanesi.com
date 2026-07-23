import type { AppProps } from "next/app";

import { HeroUIProvider } from "@heroui/system";
import { ToastProvider } from "@heroui/react";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { useRouter } from "next/router";
import { useCallback } from "react";

import "@/styles/globals.css";

import { Amplify } from "aws-amplify";
import outputs from "@/amplify_outputs.json";

Amplify.configure(outputs);

export default function App({ Component, pageProps }: AppProps) {
  const router = useRouter();
  const navigate = useCallback((path: string) => router.push(path), [router]);

  return (
    <NextThemesProvider attribute="class" defaultTheme="dark">
      <div>
        <HeroUIProvider navigate={navigate}>
          <ToastProvider placement="bottom-right" toastOffset={12} />
          <Component {...pageProps} />
        </HeroUIProvider>
      </div>
    </NextThemesProvider>
  );
}

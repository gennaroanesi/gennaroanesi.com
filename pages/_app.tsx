import type { AppProps } from "next/app";

import { HeroUIProvider } from "@heroui/system";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { useRouter } from "next/router";
import { useCallback } from "react";

import "@/styles/globals.css";
import "react-big-calendar/lib/css/react-big-calendar.css";

import { Amplify } from "aws-amplify";
import outputs from "@/amplify_outputs.json";

Amplify.configure(outputs);

export default function App({ Component, pageProps }: AppProps) {
  const router = useRouter();
  const navigate = useCallback((path: string) => router.push(path), [router]);

  return (
    <NextThemesProvider>
      <div>
        <HeroUIProvider navigate={navigate}>
          <Component {...pageProps} />
        </HeroUIProvider>
      </div>
    </NextThemesProvider>
  );
}

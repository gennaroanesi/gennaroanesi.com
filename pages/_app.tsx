import type { AppProps } from "next/app";

import { HeroUIProvider } from "@heroui/system";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { useRouter } from "next/router";

import "@/styles/globals.css";

import { Amplify } from "aws-amplify";
import outputs from "@/amplify_outputs.json";

Amplify.configure(outputs);

export default function App({ Component, pageProps }: AppProps) {
  const router = useRouter();

  return (
    <NextThemesProvider>
      <div>
        <HeroUIProvider navigate={router.push}>
          <Component {...pageProps} />
        </HeroUIProvider>
      </div>
    </NextThemesProvider>
  );
}

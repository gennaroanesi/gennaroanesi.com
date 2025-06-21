import type { AppProps } from "next/app";

import { HeroUIProvider } from "@heroui/system";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { useRouter } from "next/router";



import "@/styles/globals.css";

import { appWithTranslation } from "next-i18next";
import nextI18NextConfig from "../next-i18next.config";

import { Amplify } from "aws-amplify";
import outputs from "@/amplify_outputs.json";

Amplify.configure(outputs);

function App({ Component, pageProps }: AppProps) {
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

export default appWithTranslation(App, nextI18NextConfig);

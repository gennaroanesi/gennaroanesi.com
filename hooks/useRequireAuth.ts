import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import { fetchAuthSession } from "aws-amplify/auth";

type AuthState = "loading" | "authenticated" | "unauthenticated" | "unauthorized";

export function useRequireAuth(requiredGroup = "admins") {
  const router = useRouter();
  const [authState, setAuthState] = useState<AuthState>("loading");
  const redirectingRef = useRef(false); // prevent multiple concurrent redirects

  useEffect(() => {
    // Wait for Next.js router to be ready before reading asPath
    if (!router.isReady) return;

    async function check() {
      try {
        const session = await fetchAuthSession();

        if (!session.tokens) {
          doRedirect(router, redirectingRef);
          setAuthState("unauthenticated");
          return;
        }

        const groups: string[] =
          (session.tokens.idToken?.payload["cognito:groups"] as string[]) ?? [];

        if (requiredGroup && !groups.includes(requiredGroup)) {
          doRedirect(router, redirectingRef, "unauthorized");
          setAuthState("unauthorized");
          return;
        }

        setAuthState("authenticated");
      } catch (e) {
        console.error("[useRequireAuth] fetchAuthSession threw:", e);
        doRedirect(router, redirectingRef);
        setAuthState("unauthenticated");
      }
    }

    check();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, requiredGroup]); // router.isReady is safe — it only flips once true→true

  return { authState };
}

function doRedirect(
  router: ReturnType<typeof useRouter>,
  redirectingRef: React.MutableRefObject<boolean>,
  error?: string
) {
  // Never redirect if already in progress or already on login
  if (redirectingRef.current) return;
  if (router.pathname === "/login") return;

  redirectingRef.current = true;

  const params = new URLSearchParams();
  params.set("redirect", router.asPath);
  if (error) params.set("error", error);

  router.replace(`/login?${params.toString()}`);
}

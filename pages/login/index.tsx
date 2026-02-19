"use client";

import React, { FormEvent, useState, useEffect } from "react";
import { useRouter } from "next/router";
import {
  signIn,
  confirmSignIn,
  fetchAuthSession,
  resetPassword,
  confirmResetPassword,
} from "aws-amplify/auth";

import DefaultLayout from "@/layouts/default";
import { Card, CardBody } from "@heroui/card";
import { Input } from "@heroui/input";
import { Button } from "@heroui/button";
import { Form } from "@heroui/form";
import { Progress } from "@heroui/progress";
import { InputOtp } from "@heroui/input-otp";

// Views within the same card — no page navigation needed
type View = "login" | "forgot" | "reset" | "force_change";

export default function LoginPage() {
  const router = useRouter();

  const [view, setView]           = useState<View>("login");
  const [isLoading, setIsLoading] = useState(true); // true while checking existing session
  const [email, setEmail]         = useState("");
  const [password, setPassword]   = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [otp, setOtp]             = useState("");
  const [error, setError]         = useState<string | null>(null);
  const [info, setInfo]           = useState<string | null>(null);
  // Held in state so confirmSignIn() can be called after FORCE_CHANGE_PASSWORD
  const [pendingSignIn, setPendingSignIn] = useState<Awaited<ReturnType<typeof signIn>> | null>(null);

  const redirectTo = (router.query.redirect as string) || "/calendar";
  const authError  = router.query.error as string | undefined;

  // ── If already authenticated, skip the login page ────────────────────────
  useEffect(() => {
    fetchAuthSession()
      .then((session) => {
        if (session.tokens) {
          router.replace(redirectTo);
        } else {
          setIsLoading(false);
        }
      })
      .catch(() => setIsLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function clearMessages() {
    setError(null);
    setInfo(null);
  }

  function goTo(v: View) {
    clearMessages();
    setOtp("");
    setView(v);
  }

  // ── Sign in ───────────────────────────────────────────────────────────────
  async function handleSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearMessages();
    setIsLoading(true);

    try {
      const { nextStep } = await signIn({ username: email, password });
      if (nextStep.signInStep === "DONE") {
        router.replace(redirectTo);
      } else if (nextStep.signInStep === "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED") {
        // Admin-created user must set a permanent password before proceeding
        setPendingSignIn({ isSignedIn: false, nextStep });
        setNewPassword("");
        setConfirmPassword("");
        clearMessages();
        setView("force_change");
        setIsLoading(false);
      } else {
        setError(`Unexpected sign-in step: ${nextStep.signInStep}`);
        setIsLoading(false);
      }
    } catch (e: any) {
      setIsLoading(false);
      switch (e.name) {
        case "NotAuthorizedException":
          setError("Incorrect email or password.");
          break;
        case "UserNotFoundException":
          setError("No account found with that email.");
          break;
        case "UserNotConfirmedException":
          setError("Account not confirmed. Check your email.");
          break;
        default:
          setError(e.message ?? "Something went wrong. Please try again.");
      }
    }
  }

  // ── Request reset code ────────────────────────────────────────────────────
  async function handleForgotPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearMessages();
    setIsLoading(true);

    try {
      await resetPassword({ username: email });
      setInfo(`Reset code sent to ${email}. Check your inbox.`);
      setView("reset");
    } catch (e: any) {
      switch (e.name) {
        case "UserNotFoundException":
          setError("No account found with that email.");
          break;
        case "LimitExceededException":
          setError("Too many attempts. Please wait a few minutes and try again.");
          break;
        default:
          setError(e.message ?? "Something went wrong. Please try again.");
      }
    } finally {
      setIsLoading(false);
    }
  }

  // ── Submit new password + code ────────────────────────────────────────────
  async function handleResetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearMessages();

    if (newPassword !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }
    if (otp.length < 6) {
      setError("Please enter the full 6-digit code.");
      return;
    }

    setIsLoading(true);
    try {
      await confirmResetPassword({
        username: email,
        confirmationCode: otp,
        newPassword,
      });
      setInfo("Password reset! You can now sign in.");
      setPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setOtp("");
      goTo("login");
    } catch (e: any) {
      switch (e.name) {
        case "CodeMismatchException":
          setError("Incorrect code. Please check and try again.");
          break;
        case "ExpiredCodeException":
          setError("Code has expired. Request a new one.");
          break;
        case "InvalidPasswordException":
          setError(e.message ?? "Password doesn't meet requirements.");
          break;
        default:
          setError(e.message ?? "Something went wrong. Please try again.");
      }
    } finally {
      setIsLoading(false);
    }
  }

  // ── Force change password ─────────────────────────────────────────────────
  async function handleForceChangePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearMessages();

    if (newPassword !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }

    setIsLoading(true);
    try {
      const { nextStep } = await confirmSignIn({
        challengeResponse: newPassword,
      });
      if (nextStep.signInStep === "DONE") {
        router.replace(redirectTo);
      } else {
        setError(`Unexpected step after password change: ${nextStep.signInStep}`);
        setIsLoading(false);
      }
    } catch (e: any) {
      setIsLoading(false);
      switch (e.name) {
        case "InvalidPasswordException":
          setError(e.message ?? "Password doesn't meet requirements.");
          break;
        case "NotAuthorizedException":
          // Session expired — send back to login
          setError("Session expired. Please sign in again.");
          setPendingSignIn(null);
          goTo("login");
          break;
        default:
          setError(e.message ?? "Something went wrong. Please try again.");
      }
    }
  }

  // ── Titles per view ───────────────────────────────────────────────────────
  const titles: Record<View, string> = {
    login:        "Sign in",
    forgot:       "Reset password",
    reset:        "Enter new password",
    force_change: "Set your password",
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <DefaultLayout>
      <div className="flex justify-center items-center h-[calc(100vh-4rem)]">
        <div className="w-full max-w-sm px-8">

          {/* Loading bar sits above the card */}
          {isLoading && (
            <Progress
              isIndeterminate
              aria-label="Loading..."
              className="mb-0 rounded-t"
              size="sm"
            />
          )}

          <Card className={`max-w-full ${isLoading ? "rounded-t-none" : ""}`}>
            <CardBody className="flex flex-col gap-4 p-6">

              <h1 className="text-lg font-semibold text-purple dark:text-rose text-center">
                {titles[view]}
              </h1>

              {/* Unauthorized error from redirect */}
              {authError === "unauthorized" && view === "login" && (
                <p className="text-sm text-red-500 text-center">
                  Your account doesn't have access to that page.
                </p>
              )}

              {/* Inline error / info messages */}
              {error && (
                <p className="text-sm text-red-500 text-center">{error}</p>
              )}
              {info && (
                <p className="text-sm text-green-600 dark:text-green-400 text-center">
                  {info}
                </p>
              )}

              {/* ── LOGIN VIEW ─────────────────────────────────────────── */}
              {view === "login" && (
                <Form className="flex flex-col gap-4" onSubmit={handleSignIn}>
                  <Input
                    isRequired
                    isDisabled={isLoading}
                    name="email"
                    label="Email"
                    placeholder="Enter your email"
                    type="email"
                    value={email}
                    onValueChange={setEmail}
                  />
                  <Input
                    isRequired
                    isDisabled={isLoading}
                    name="password"
                    label="Password"
                    placeholder="Enter your password"
                    type="password"
                    value={password}
                    onValueChange={setPassword}
                  />
                  <div className="flex justify-end w-full">
                    <button
                      type="button"
                      className="text-xs text-gray-400 hover:text-purple dark:hover:text-rose transition-colors"
                      onClick={() => goTo("forgot")}
                    >
                      Forgot password?
                    </button>
                  </div>
                  <Button
                    fullWidth
                    color="primary"
                    type="submit"
                    isLoading={isLoading}
                    isDisabled={isLoading}
                  >
                    Sign in
                  </Button>
                </Form>
              )}

              {/* ── FORGOT VIEW ────────────────────────────────────────── */}
              {view === "forgot" && (
                <Form className="flex flex-col gap-4" onSubmit={handleForgotPassword}>
                  <p className="text-sm text-gray-500 dark:text-gray-400 text-center">
                    Enter your email and we'll send you a reset code.
                  </p>
                  <Input
                    isRequired
                    isDisabled={isLoading}
                    name="email"
                    label="Email"
                    placeholder="Enter your email"
                    type="email"
                    value={email}
                    onValueChange={setEmail}
                  />
                  <Button
                    fullWidth
                    color="primary"
                    type="submit"
                    isLoading={isLoading}
                    isDisabled={isLoading}
                  >
                    Send reset code
                  </Button>
                  <button
                    type="button"
                    className="text-xs text-gray-400 hover:text-purple dark:hover:text-rose transition-colors text-center"
                    onClick={() => goTo("login")}
                  >
                    ← Back to sign in
                  </button>
                </Form>
              )}

              {/* ── FORCE CHANGE PASSWORD VIEW ────────────────────────── */}
              {view === "force_change" && (
                <Form className="flex flex-col gap-4" onSubmit={handleForceChangePassword}>
                  <p className="text-sm text-gray-500 dark:text-gray-400 text-center">
                    Your account requires a new password before you can continue.
                  </p>
                  <Input
                    isRequired
                    isDisabled={isLoading}
                    name="newPassword"
                    label="New password"
                    placeholder="Enter new password"
                    type="password"
                    value={newPassword}
                    onValueChange={setNewPassword}
                  />
                  <Input
                    isRequired
                    isDisabled={isLoading}
                    name="confirmPassword"
                    label="Confirm new password"
                    placeholder="Repeat new password"
                    type="password"
                    value={confirmPassword}
                    onValueChange={setConfirmPassword}
                  />
                  <Button
                    fullWidth
                    color="primary"
                    type="submit"
                    isLoading={isLoading}
                    isDisabled={isLoading}
                  >
                    Set password & sign in
                  </Button>
                </Form>
              )}

              {/* ── RESET VIEW ─────────────────────────────────────────── */}
              {view === "reset" && (
                <Form className="flex flex-col gap-4" onSubmit={handleResetPassword}>
                  <p className="text-sm text-gray-500 dark:text-gray-400 text-center">
                    Enter the 6-digit code sent to{" "}
                    <span className="font-medium dark:text-rose text-purple">{email}</span>.
                  </p>

                  {/* OTP input centered */}
                  <div className="flex justify-center">
                    <InputOtp
                      length={6}
                      value={otp}
                      onValueChange={setOtp}
                      isDisabled={isLoading}
                    />
                  </div>

                  <Input
                    isRequired
                    isDisabled={isLoading}
                    name="newPassword"
                    label="New password"
                    placeholder="Enter new password"
                    type="password"
                    value={newPassword}
                    onValueChange={setNewPassword}
                  />
                  <Input
                    isRequired
                    isDisabled={isLoading}
                    name="confirmPassword"
                    label="Confirm new password"
                    placeholder="Repeat new password"
                    type="password"
                    value={confirmPassword}
                    onValueChange={setConfirmPassword}
                  />

                  <Button
                    fullWidth
                    color="primary"
                    type="submit"
                    isLoading={isLoading}
                    isDisabled={isLoading || otp.length < 6}
                  >
                    Set new password
                  </Button>

                  {/* Resend code */}
                  <div className="flex justify-between text-xs text-gray-400">
                    <button
                      type="button"
                      className="hover:text-purple dark:hover:text-rose transition-colors"
                      onClick={() => goTo("forgot")}
                    >
                      Resend code
                    </button>
                    <button
                      type="button"
                      className="hover:text-purple dark:hover:text-rose transition-colors"
                      onClick={() => goTo("login")}
                    >
                      ← Back to sign in
                    </button>
                  </div>
                </Form>
              )}

            </CardBody>
          </Card>
        </div>
      </div>
    </DefaultLayout>
  );
}

"use client";

import React, { FormEvent, useState, useEffect } from "react";
import { useRouter } from "next/router";

import {
  signIn,
  signUp,
  confirmSignUp,
  getCurrentUser,
  fetchAuthSession,
  autoSignIn,
  resendSignUpCode,
} from "aws-amplify/auth";
import { Amplify } from "aws-amplify";

import outputs from "@/amplify_outputs.json";

Amplify.configure(outputs);

import DefaultLayout from "@/layouts/default";

import { Tabs, Tab } from "@heroui/tabs";
import { Card, CardBody } from "@heroui/card";
import { Input } from "@heroui/input";
import { InputOtp } from "@heroui/input-otp";
import { Button } from "@heroui/button";
import { Link } from "@heroui/link";
import { Form } from "@heroui/form";
import { Progress } from "@heroui/progress";

export default function Admin() {
  const router = useRouter();

  const [selectedTab, setSelectedTab] = useState("login");
  const [isLoading, setIsLoading] = useState(false);
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showOtp, setShowOtp] = useState(false);
  const [otp, setOtp] = useState("");
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  useEffect(() => {
    if (otp.length == 6) {
      handleConfirmSignUp(username, otp);
    }
  }, [otp]);

  useEffect(() => {
    checkLoggedIn();
    if (isLoggedIn) {
      router.push("/admin");
    }
  }, []);

  async function checkLoggedIn() {
    try {
      const userData = await fetchAuthSession();
      if (userData.credentials) {
        setIsLoggedIn(true);
      }
      console.log(userData);
    } catch (e) {
      console.log(e);
    }
  }

  async function handleSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));

    console.log(data);

    try {
      setIsLoading(true);
      const { isSignedIn, nextStep } = await signIn({
        username: data.email.toString(),
        password: data.password.toString(),
      });
      setIsLoading(false);
      console.log(isSignedIn);
      console.log(nextStep);
      if (nextStep.signInStep === "DONE") {
        router.push("/");
      }
    } catch (e) {
      setIsLoading(false);
      console.log(e);
    }
  }

  async function handleSignUp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));

    console.log(data);

    try {
      setIsLoading(true);
      const { isSignUpComplete, userId, nextStep } = await signUp({
        username: data.email.toString(),
        password: data.password.toString(),
        options: {
          userAttributes: {
            name: name,
          },
        },
      });
      console.log(isSignUpComplete);
      console.log(nextStep);
      setIsLoading(false);
      setShowOtp(true);
    } catch (e) {
      setIsLoading(false);
      console.log(e);
    }
  }

  async function handleConfirmSignUp(username: string, code: string) {
    setIsLoading(true);
    try {
      const { isSignUpComplete, nextStep } = await confirmSignUp({
        username: username,
        confirmationCode: code,
      });
      setIsLoading(false);
      setSelectedTab("login");
    } catch (e) {
      setIsLoading(false);
      console.log(e);
    }
  }

  async function handleResendOtp(e: any) {
    setIsLoading(true);
    try {
      await resendSignUpCode({
        username: username,
      });
    } catch (e) {
      setIsLoading(false);
      console.log(e);
    }
  }

  return (
    <DefaultLayout>
      <div className="flex justify-center">
        <div className="w-full py-16 px-8 lg:w-1/4">
          <Card className="max-w-full">
            {isLoading ? (
              <Progress
                isIndeterminate
                aria-label="Loading..."
                className="max-w-md"
                size="sm"
              />
            ) : null}
            <CardBody className="overflow-hidden">
              <Tabs
                fullWidth
                aria-label="Tabs form"
                selectedKey={selectedTab}
                size="md"
                onSelectionChange={(e) => {
                  setSelectedTab(e.toString());
                  setIsLoading(false);
                }}
              >
                <Tab key="login" title="Login">
                  <Form className="flex flex-col gap-4" onSubmit={handleSignIn}>
                    <Input
                      isRequired
                      name="email"
                      label="Email"
                      placeholder="Enter your email"
                      type="email"
                      value={username}
                      onValueChange={setUsername}
                    />
                    <Input
                      isRequired
                      name="password"
                      label="Password"
                      placeholder="Enter your password"
                      type="password"
                      value={password}
                      onValueChange={setPassword}
                    />
                    <p className="text-center text-small">
                      Need to create an account?{" "}
                      <Link
                        className="cursor-pointer"
                        size="sm"
                        onPress={() => setSelectedTab("sign-up")}
                      >
                        Sign up
                      </Link>
                    </p>
                    <div className="flex gap-2 justify-end">
                      <Button fullWidth color="primary" type="submit">
                        Login
                      </Button>
                    </div>
                  </Form>
                </Tab>
                <Tab key="sign-up" title="Sign up">
                  <Form className="flex flex-col gap-4" onSubmit={handleSignUp}>
                    <Input
                      isRequired
                      name="name"
                      label="Name"
                      placeholder="Enter your name"
                      type="name"
                      value={name}
                      onValueChange={setName}
                    />
                    <Input
                      isRequired
                      name="email"
                      label="Email"
                      placeholder="Enter your email"
                      type="email"
                      value={username}
                      onValueChange={setUsername}
                    />
                    <Input
                      isRequired
                      name="password"
                      label="Password"
                      placeholder="Enter your password"
                      type="password"
                    />
                    <p className="text-center text-small">
                      Already have an account?{" "}
                      <Link
                        className="cursor-pointer"
                        size="sm"
                        onPress={() => setSelectedTab("login")}
                      >
                        Login
                      </Link>
                    </p>
                    <div className="flex gap-2 justify-end">
                      <Button color="primary" type="submit">
                        Sign up
                      </Button>
                    </div>
                  </Form>
                  <div className="py-4">
                    {showOtp ? (
                      <>
                        <InputOtp
                          className="py-4"
                          length={6}
                          value={otp}
                          onValueChange={setOtp}
                          description="Enter your One-Time Passcode"
                        />
                        <Button
                          color="primary"
                          type="submit"
                          size="sm"
                          variant="light"
                          onPress={handleResendOtp}
                        >
                          Resend OTP
                        </Button>
                      </>
                    ) : null}
                  </div>
                </Tab>
              </Tabs>
            </CardBody>
          </Card>
        </div>
      </div>
    </DefaultLayout>
  );
}

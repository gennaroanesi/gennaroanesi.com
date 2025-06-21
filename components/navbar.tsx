"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/router";

import {
  Navbar as NextUINavbar,
  NavbarContent,
  NavbarMenu,
  NavbarMenuToggle,
  NavbarBrand,
  NavbarItem,
  NavbarMenuItem,
} from "@heroui/navbar";
import { Link } from "@heroui/link";
import NextLink from "next/link";
import { Button } from "@heroui/button";

export const Navbar = () => {
  const [showMessageModal, setShowMessageModal] = useState(false);

  const router = useRouter();

  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const onScroll = () => setOffset(window.scrollY);
    // clean up code
    window.removeEventListener("scroll", onScroll);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const menuItems = [
    {
      name: "Home",
      href: "/#top",
    },
  ];

  const menuOption = (name: string, href: string) => {
    switch (name) {
      default:
        return (
          <Link
            as={NextLink}
            className="text-inherit w-full transparent h-[40px] lg:leading-loose lg:align-middle lg:uppercase lg:mix-blend-difference"
            href={href}
            size="lg"
          >
            {name}
          </Link>
        );
    }
  };

  return (
    <NextUINavbar
      id="top"
      className={
        router.pathname == "/"
          ? `bg-transparent backdrop-blur-none text-whiteishText ${offset > 80 ? "blur-navbar" : ""}`
          : `text-mainTextColor bg-transparent`
      }
      maxWidth="xl"
      position="sticky"
      isMenuOpen={isMenuOpen}
      onMenuOpenChange={setIsMenuOpen}
    >
      <NavbarContent className="basis-1/5 sm:basis-full" justify="start">
        <NavbarBrand className="max-w-fit">
          <NextLink className="flex justify-start items-center gap-1" href="/">
            <p className="hidden lg:block font-bold text-inherit font-FrancieScript text-3xl">
              GA
            </p>
            <p className="display-flex lg:hidden font-bold text-inherit font-FrancieScript text-xl">
              GA
            </p>
          </NextLink>
        </NavbarBrand>
      </NavbarContent>
      <NavbarContent
        className="hidden lg:flex gap-10 justify-end ml-auto font-CaslonPro font-semibold"
        justify="end"
      >
        {menuItems.map((item) => (
          <NavbarItem key={item.href}>
            {menuOption(item.name, item.href)}
          </NavbarItem>
        ))}
      </NavbarContent>
      {/*Mobile Menu*/}
      <NavbarMenuToggle
        aria-label={isMenuOpen ? "Close menu" : "Open menu"}
        className="flex lg:hidden"
      />
      <NavbarMenu className="backdrop-blur-sm bg-transparent backdrop-brightness-[30%] font-CaslonPro uppercase">
        {menuItems.map((item, index) => (
          <NavbarMenuItem
            key={`${item}-${index}`}
            className="text-whiteishText"
          >
            {menuOption(item.name, item.href)}
          </NavbarMenuItem>
        ))}
      </NavbarMenu>
    </NextUINavbar>
  );
};

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

import { ReactSVG } from 'react-svg'
import IconSvg from "@/public/icon_svg.svg";

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
    {
      name: "Login",
      href: "/login",
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
          ? `bg-transparent backdrop-blur-none  ${offset > 80 ? "blur-navbar" : ""}`
          : `bg-transparent`
      }
      maxWidth="xl"
      position="sticky"
      isMenuOpen={isMenuOpen}
      onMenuOpenChange={setIsMenuOpen}
    >
      <NavbarContent className="basis-1/5 sm:basis-full" justify="start">
        <NavbarBrand className="max-w-fit">
          <NextLink className="flex justify-start items-center gap-1" href="/">
            <ReactSVG className="h-8 w-8 fill-purple" src={IconSvg.src} wrapper="svg"/>
          </NextLink>
        </NavbarBrand>
      </NavbarContent>
      <NavbarContent
        className="hidden lg:flex gap-10 justify-end ml-auto font-semibold text-purple"
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
        className="flex lg:hidden text-purple"
      />
      <NavbarMenu className="backdrop-blur-sm bg-transparent backdrop-brightness-[30%] uppercase">
        {menuItems.map((item, index) => (
          <NavbarMenuItem key={`${item}-${index}`}>
            {menuOption(item.name, item.href)}
          </NavbarMenuItem>
        ))}
      </NavbarMenu>
    </NextUINavbar>
  );
};

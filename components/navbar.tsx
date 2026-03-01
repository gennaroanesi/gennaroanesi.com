"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/router";
import { getCurrentUser } from "aws-amplify/auth";

import {
  Navbar as NextUINavbar,
  NavbarContent,
  NavbarMenu,
  NavbarMenuToggle,
  NavbarBrand,
  NavbarItem,
  NavbarMenuItem,
} from "@heroui/navbar";
import {
  DropdownItem,
  DropdownTrigger,
  Dropdown,
  DropdownMenu,
} from "@heroui/dropdown";
import { Button } from "@heroui/button";
import { Link } from "@heroui/link";
import NextLink from "next/link";

import { FaUserSecret, FaChevronDown } from "react-icons/fa";
import { ReactSVG } from "react-svg";
import IconSvg from "@/public/icon_svg.svg";

const menuItems = [
  {
    name: "Home",
    href: "/#top",
  },
];

const adminMenu = [
  {
    name: "Admin Home",
    href: "/admin",
  },
  {
    name: "Calendar",
    href: "/calendar",
  },
  {
    name: "Inventory",
    href: "/inventory",
  },
];

const AdminDropdown = () => {
  return (
    <div className="">
      <Dropdown className="rounded-none">
        <NavbarItem>
          <DropdownTrigger>
            <Link
              className="dark:text-rose text-purple w-full transparent h-[40px] lg:leading-loose lg:align-middle lg:uppercase lg:mix-blend-difference cursor-pointer"
              size="lg"
            >
              Admin
            </Link>
          </DropdownTrigger>
        </NavbarItem>
        <DropdownMenu
          aria-label="Admin Menu"
          itemClasses={{
            base: "gap-4",
          }}
        >
          {adminMenu.map((opt, idx) => (
            <DropdownItem key={idx} href={opt.href} className="rounded-none">
              {opt.name}
            </DropdownItem>
          ))}
        </DropdownMenu>
      </Dropdown>
    </div>
  );
};

export const Navbar = () => {
  const router = useRouter();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  useEffect(() => {
    const onScroll = () => setOffset(window.scrollY);
    // clean up code
    window.removeEventListener("scroll", onScroll);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    getUserData();
  }, []);

  async function getUserData() {
    try {
      const { username, userId, signInDetails } = await getCurrentUser();
      if (userId) {
        setIsLoggedIn(true);
      } else {
        setIsLoggedIn(false);
      }
    } catch (e) {
      setIsLoggedIn(false);
    }
  }

  const menuOption = (name: string, href: string) => {
    if (name == "Login" && isLoggedIn) {
      return;
    }
    switch (name) {
      default:
        return (
          <Link
            as={NextLink}
            className="dark:text-rose text-purple w-full transparent h-[40px] lg:leading-loose lg:align-middle lg:uppercase lg:mix-blend-difference"
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
            <ReactSVG
              className="h-8 w-8 fill-purple dark:fill-rose"
              src={IconSvg.src}
              wrapper="svg"
            />
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
        {isLoggedIn ? (
          <AdminDropdown />
        ) : (
          <NavbarItem key="admin" className="hidden lg:flex">
            <Link
              as={NextLink}
              className="text-inherit w-full transparent h-[40px] lg:leading-[40px] lg:align-middle lg:uppercase lg:mix-blend-difference"
              href="/login"
              size="lg"
            >
              <FaUserSecret />
            </Link>
          </NavbarItem>
        )}
      </NavbarContent>
      {/*Mobile Menu*/}
      <NavbarMenuToggle
        aria-label={isMenuOpen ? "Close menu" : "Open menu"}
        className="flex lg:hidden text-purple dark:text-rose"
      />
      <NavbarMenu className="backdrop-blur-sm bg-transparent backdrop-brightness-[80%] dark:backdrop-brightness-[30%] uppercase">
        {menuItems.map((item, index) => (
          <NavbarMenuItem key={`${item}-${index}`}>
            {menuOption(item.name, item.href)}
          </NavbarMenuItem>
        ))}
        <NavbarMenuItem key="Admin" className="text-whiteishText">
          Admin
        </NavbarMenuItem>
        {adminMenu.map((item, index) => (
          <NavbarMenuItem
            key={`10-${item}-${index}`}
            className="text-whiteishText"
          >
            <Link
              as={NextLink}
              className="indent-8 lg:block text-inherit w-full transparent h-[40px] lg:leading-[40px] lg:align-middle lg:uppercase lg:mix-blend-difference"
              size="lg"
              href="#"
              onPress={(e) => {
                router.push(item.href);
                setIsMenuOpen(false);
              }}
            >
              {item.name}
            </Link>
          </NavbarMenuItem>
        ))}
      </NavbarMenu>
    </NextUINavbar>
  );
};

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
  DropdownSection,
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
  {
    name: "Intro",
    href: "/intro",
  },
  {
    name: "Timeline",
    href: "/timeline",
  },
  {
    name: "Flying",
    href: "/flying",
  },
];

// Admin dropdown is split into two groups:
//  - "Public configs" — pages that manage content the public site shows
//  - "Tools" — internal-only apps + utilities
type AdminItem = { name: string; href: string };
const adminPublicConfigs: AdminItem[] = [
  { name: "Home page", href: "/admin/homepage" },
  { name: "Projects",  href: "/admin/projects" },
  { name: "Timeline",  href: "/admin/timeline" },
];
const adminTools: AdminItem[] = [
  { name: "Admin Home", href: "/admin" },
  { name: "Calendar",   href: "/calendar" },
  { name: "Inventory",  href: "/inventory" },
  { name: "Finance",    href: "/finance" },
  { name: "Notes",      href: "/notes" },
  { name: "Tasks",      href: "/tasks" },
  { name: "Flights",    href: "/admin/flights" },
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
          className="bg-darkSurface border border-darkBorder"
          itemClasses={{
            base: "gap-4 data-[hover=true]:bg-white/10 rounded-none",
            title: "text-gray-200",
          }}
        >
          <DropdownSection
            title="Public configs"
            classNames={{
              heading: "text-[10px] uppercase tracking-widest text-gray-500 px-2 pt-1",
              divider: "bg-darkBorder",
            }}
            showDivider
          >
            {adminPublicConfigs.map((opt) => (
              <DropdownItem key={opt.href} href={opt.href} className="rounded-none">
                {opt.name}
              </DropdownItem>
            ))}
          </DropdownSection>
          <DropdownSection
            title="Tools"
            classNames={{
              heading: "text-[10px] uppercase tracking-widest text-gray-500 px-2 pt-1",
            }}
          >
            {adminTools.map((opt) => (
              <DropdownItem key={opt.href} href={opt.href} className="rounded-none">
                {opt.name}
              </DropdownItem>
            ))}
          </DropdownSection>
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

  // On the flying page, hide navbar on mobile (full-bleed map layout)
  const isFlyingPage = router.pathname === "/flying";
  // On the home page, render the navbar in solid white (full-bleed hero behind it)
  const isHomePage = router.pathname === "/";

  const menuOption = (name: string, href: string) => {
    if (name == "Login" && isLoggedIn) {
      return;
    }
    switch (name) {
      default:
        return (
          <Link
            as={NextLink}
            className={
              isHomePage
                ? "text-white w-full transparent h-[40px] lg:leading-loose lg:align-middle lg:uppercase drop-shadow"
                : "dark:text-rose text-purple w-full transparent h-[40px] lg:leading-loose lg:align-middle lg:uppercase lg:mix-blend-difference"
            }
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
        isFlyingPage
          ? `bg-transparent lg:flex hidden`
          : router.pathname == "/"
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
              className={
                isHomePage
                  ? "h-8 w-8 fill-white drop-shadow"
                  : "h-8 w-8 fill-purple dark:fill-rose"
              }
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
              className={
                isHomePage
                  ? "text-white w-full transparent h-[40px] lg:leading-[40px] lg:align-middle lg:uppercase drop-shadow"
                  : "text-inherit w-full transparent h-[40px] lg:leading-[40px] lg:align-middle lg:uppercase lg:mix-blend-difference"
              }
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
        className={
          isHomePage
            ? "flex lg:hidden text-white drop-shadow"
            : "flex lg:hidden text-purple dark:text-rose"
        }
      />
      <NavbarMenu className="backdrop-blur-sm bg-transparent backdrop-brightness-[80%] dark:backdrop-brightness-[30%] uppercase">
        {menuItems.map((item, index) => (
          <NavbarMenuItem key={`${item}-${index}`}>
            {menuOption(item.name, item.href)}
          </NavbarMenuItem>
        ))}
        {isLoggedIn && (
          <>
            <NavbarMenuItem key="AdminPublic" className="text-whiteishText">
              Admin · Public configs
            </NavbarMenuItem>
            {adminPublicConfigs.map((item, index) => (
              <NavbarMenuItem
                key={`pub-${item.href}-${index}`}
                className="text-whiteishText"
              >
                <Link
                  as={NextLink}
                  className="indent-8 lg:block text-inherit w-full transparent h-[40px] lg:leading-[40px] lg:align-middle lg:uppercase lg:mix-blend-difference"
                  size="lg"
                  href="#"
                  onPress={() => {
                    router.push(item.href);
                    setIsMenuOpen(false);
                  }}
                >
                  {item.name}
                </Link>
              </NavbarMenuItem>
            ))}
            <NavbarMenuItem key="AdminTools" className="text-whiteishText">
              Admin · Tools
            </NavbarMenuItem>
            {adminTools.map((item, index) => (
              <NavbarMenuItem
                key={`tool-${item.href}-${index}`}
                className="text-whiteishText"
              >
                <Link
                  as={NextLink}
                  className="indent-8 lg:block text-inherit w-full transparent h-[40px] lg:leading-[40px] lg:align-middle lg:uppercase lg:mix-blend-difference"
                  size="lg"
                  href="#"
                  onPress={() => {
                    router.push(item.href);
                    setIsMenuOpen(false);
                  }}
                >
                  {item.name}
                </Link>
              </NavbarMenuItem>
            ))}
          </>
        )}
      </NavbarMenu>
    </NextUINavbar>
  );
};

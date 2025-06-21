"use client";

import { useTranslation } from "next-i18next";
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
import { Select, SelectItem } from "@heroui/select";
import { Avatar } from "@heroui/avatar";

export const Navbar = () => {
  const [showMessageModal, setShowMessageModal] = useState(false);

  const router = useRouter();

  const { t, i18n } = useTranslation("common");

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
      name: t("navbar.home"),
      href: "/#top",
    },
  ];

  const menuOption = (name: string, href: string) => {
    switch (name) {
      case "RSVP":
        return (
          <Button
            as={NextLink}
            size="md"
            radius="none"
            className="bg-mainTextColor text-whiteishText px-1"
            variant="shadow"
            href={href}
          >
            RSVP
          </Button>
        );
      case "message":
        return (
          <Link
            as={NextLink}
            className="text-inherit w-full transparent h-[40px] lg:leading-loose lg:align-middle lg:uppercase lg:mix-blend-difference"
            onPress={() => setShowMessageModal(!showMessageModal)}
            size="lg"
            href=""
          >
            {t("navbar.message_board")}
          </Link>
        );
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

  const changeLanguage = (locale: string) => {
    router.push(
      {
        pathname: router.pathname,
        query: router.query,
      },
      router.asPath,
      { locale },
    );
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
        <NavbarItem>
          <Select
            variant="flat"
            radius="none"
            classNames={{
              base: "p-2 w-24",
              label: "px-0",
              popoverContent: "rounded-none",
              trigger: "bg-transparent",
            }}
            aria-label="Select language"
            items={[{ key: "en" }, { key: "pt-BR" }]}
            selectedKeys={[i18n.language]}
            renderValue={(items) => {
              return (
                <div className="flex flex-wrap gap-2">
                  {items.map((item) => (
                    <Avatar
                      key={item.key}
                      alt="USA"
                      className="w-6 h-6 m-auto"
                      src={`https://flagcdn.com/${item.key === "en" ? "us" : "br"}.svg`}
                    />
                  ))}
                </div>
              );
            }}
            onChange={(e) => {
              changeLanguage(e.target.value);
            }}
          >
            <SelectItem
              key="pt-BR"
              textValue="Português"
              hideSelectedIcon
              classNames={{
                base: "rounded-none m-auto",
              }}
            >
              <Avatar
                alt="Brazil"
                className="w-6 h-6 m-auto"
                src="https://flagcdn.com/br.svg"
              />
            </SelectItem>
            <SelectItem
              key="en"
              textValue="English"
              hideSelectedIcon
              classNames={{
                base: "rounded-none",
              }}
            >
              <Avatar
                alt="USA"
                className="w-6 h-6 m-auto"
                src="https://flagcdn.com/us.svg"
              />
            </SelectItem>
          </Select>
        </NavbarItem>
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
        <NavbarMenuItem>
          <Select
            variant="flat"
            radius="none"
            fullWidth={false}
            classNames={{
              base: "font-CaslonPro uppercase w-1/2",
              label: "h-[40px]",
              popoverContent: "rounded-none",
              trigger: "bg-transparent shadow-none",
              mainWrapper: "max-h-full",
            }}
            aria-label="Select language"
            label={
              <div className="text-whiteishText text-large table-cell align-middle h-[40px] leading-[44px]">
                {t("navbar.language")}
              </div>
            }
            labelPlacement="outside-left"
            items={[{ key: "en" }, { key: "pt-BR" }]}
            selectedKeys={[i18n.language]}
            renderValue={(items) => {
              return (
                <div className="flex flex-wrap gap-2">
                  {items.map((item) => (
                    <Avatar
                      key={item.key}
                      alt={item.key === "en" ? "USA" : "BR"}
                      className="w-4 h-4 m-auto min-w-4"
                      src={`https://flagcdn.com/${item.key === "en" ? "us" : "br"}.svg`}
                    />
                  ))}
                </div>
              );
            }}
            onChange={(e) => {
              changeLanguage(e.target.value);
            }}
          >
            <SelectItem
              key="pt-BR"
              textValue="Português"
              hideSelectedIcon
              classNames={{
                base: "rounded-none m-auto",
              }}
            >
              <Avatar
                alt="Brazil"
                className="w-6 h-6 m-auto"
                src="https://flagcdn.com/br.svg"
              />
            </SelectItem>
            <SelectItem
              key="en"
              textValue="English"
              hideSelectedIcon
              classNames={{
                base: "rounded-none",
              }}
            >
              <Avatar
                alt="USA"
                className="w-6 h-6 m-auto"
                src="https://flagcdn.com/us.svg"
              />
            </SelectItem>
          </Select>
        </NavbarMenuItem>
      </NavbarMenu>
    </NextUINavbar>
  );
};

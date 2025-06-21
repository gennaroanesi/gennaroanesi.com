"use client";

import { useTranslation } from "next-i18next";
import React, { useState, useEffect } from "react";
import { useRouter } from "next/router";
import type { GetStaticProps } from "next";

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
    {
      name: t("navbar.wedding"),
      href: "/#wedding",
    },
    {
      name: t("navbar.tips"),
      href: "/tips",
    },
    {
      name: "RSVP",
      href: "/rsvp",
    },
    /*{
      "name": t('navbar.about_us'),
      "href": '/about_us'
    }, */
  ];

  const changeLanguage = (locale: string) => {
    router.push(
      {
        pathname: router.pathname,
        query: router.query,
      },
      router.asPath,
      { locale }
    );
  };

  return (
    <NextUINavbar
      id="top"
      className={`bg-transparent backdrop-blur-none text-mainTextColor ${offset > 80 ? "blur-navbar" : ""}`}
      maxWidth="xl"
      position="sticky"
      isMenuOpen={isMenuOpen}
      onMenuOpenChange={setIsMenuOpen}
    >
      <NavbarContent className="basis-1/5 sm:basis-full" justify="start">
        <NavbarBrand className="gap-3 max-w-fit">
          <NextLink className="flex justify-start items-center gap-1" href="/">
            <p className="hidden lg:block font-bold text-inherit font-FrancieScript text-3xl">
              C&G
            </p>
            <p className="display-flex lg:hidden font-bold text-inherit font-FrancieScript text-xl">
              C&G
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
            {item.name === "RSVP" ? (
              <Button
                as={NextLink}
                size="md"
                radius="none"
                className="bg-mainTextColor text-whiteishText px-1"
                variant="shadow"
                href={item.href}
              >
                RSVP
              </Button>
            ) : (
              <NextLink
                className="leading-loose align-middle uppercase text-mainTextColor mix-blend-difference"
                href={item.href}
              >
                {item.name}
              </NextLink>
            )}
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
      <NavbarMenuToggle
        aria-label={isMenuOpen ? "Close menu" : "Open menu"}
        className="flex lg:hidden text-mainTextColor"
      />
      <NavbarMenu className="backdrop-blur-sm bg-transparent backdrop-brightness-[30%] font-CaslonPro uppercase">
        {menuItems.map((item, index) => (
          <NavbarMenuItem key={`${item}-${index}`}>
            {item.name === "RSVP" ? (
              <Button
                as={NextLink}
                size="md"
                radius="none"
                className="bg-mainTextColor text-whiteishText"
                variant="flat"
                href="/rsvp"
              >
                RSVP
              </Button>
            ) : (
              <Link
                className="w-full transparent text-whiteishText h-[40px]"
                href={item.href}
                size="lg"
                onClick={() => {
                  if (item.name === "RSVP") {
                    setIsMenuOpen(false);
                    //setIsRSVPModalOpen(true);
                  } else {
                    setIsMenuOpen(false);
                  }
                }}
              >
                {item.name}
              </Link>
            )}
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
                      className="w-4 h-4 m-auto"
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

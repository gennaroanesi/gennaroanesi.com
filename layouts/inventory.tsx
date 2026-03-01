import React from "react";
import { useRouter } from "next/router";
import NextLink from "next/link";
import { Listbox, ListboxItem, ListboxSection } from "@heroui/listbox";
import { Divider } from "@heroui/divider";
import { Chip } from "@heroui/chip";
import DefaultLayout from "@/layouts/default";
import { CATEGORY_CONFIG, Category } from "@/pages/inventory/_shared";

const NAV_ITEMS: { key: string; label: string; href: string; color: string }[] = [
  { key: "all",        label: "All Items",  href: "/inventory",             color: "#BCABAE" },
  { key: "firearms",   label: "Firearms",   href: "/inventory/firearms",    color: CATEGORY_CONFIG.FIREARM.color },
  { key: "ammo",       label: "Ammo",       href: "/inventory/ammo",        color: CATEGORY_CONFIG.AMMO.color },
  { key: "filaments",  label: "Filaments",  href: "/inventory/filaments",   color: CATEGORY_CONFIG.FILAMENT.color },
  { key: "instruments",label: "Instruments",href: "/inventory/instruments", color: CATEGORY_CONFIG.INSTRUMENT.color },
];

// Map pathnames to nav keys
function activeKey(pathname: string): string {
  if (pathname === "/inventory") return "all";
  if (pathname.includes("firearms"))   return "firearms";
  if (pathname.includes("ammo"))       return "ammo";
  if (pathname.includes("filaments"))  return "filaments";
  if (pathname.includes("instruments"))return "instruments";
  return "all";
}

export default function InventoryLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const active = activeKey(router.pathname);

  return (
    <DefaultLayout>
      <div className="flex h-[calc(100vh-4rem)]">

        {/* ── Sidebar ───────────────────────────────────────────────────── */}
        <aside className="w-48 flex-shrink-0 border-r border-gray-200 dark:border-gray-700 flex flex-col py-4 bg-white dark:bg-darkPurple">
          <p className="px-4 text-[10px] uppercase tracking-widest text-gray-400 dark:text-gray-500 mb-2 font-medium">
            Inventory
          </p>

          <Listbox
            aria-label="Inventory navigation"
            variant="flat"
            selectionMode="single"
            selectedKeys={new Set([active])}
            disallowEmptySelection
            classNames={{
              base: "px-2",
              list: "gap-1",
            }}
          >
            {NAV_ITEMS.map((item) => {
              const isActive = item.key === active;
              return (
                <ListboxItem
                  key={item.key}
                  as={NextLink}
                  href={item.href}
                  textValue={item.label}
                  classNames={{
                    base: [
                      "rounded-lg px-3 py-2 transition-colors",
                      isActive
                        ? "bg-opacity-10"
                        : "hover:bg-gray-100 dark:hover:bg-white/5",
                    ].join(" "),
                    title: "text-sm font-medium",
                  }}
                  style={isActive ? {
                    backgroundColor: item.color + "22",
                    color: item.color,
                  } : undefined}
                  startContent={
                    <span
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ backgroundColor: isActive ? item.color : item.color + "66" }}
                    />
                  }
                >
                  {item.label}
                </ListboxItem>
              );
            })}
          </Listbox>

          <Divider className="my-3 mx-4 w-auto" />

          {/* Quick-add links */}
          <p className="px-4 text-[10px] uppercase tracking-widest text-gray-400 dark:text-gray-500 mb-2 font-medium">
            Add New
          </p>
          <div className="px-2 flex flex-col gap-1">
            {NAV_ITEMS.filter((i) => i.key !== "all").map((item) => (
              <NextLink
                key={item.key}
                href={`${item.href}?new=1`}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors hover:bg-gray-100 dark:hover:bg-white/5"
                style={{ color: item.color }}
              >
                <span className="text-base leading-none">+</span>
                {item.label}
              </NextLink>
            ))}
          </div>
        </aside>

        {/* ── Page content ──────────────────────────────────────────────── */}
        <div className="flex-1 min-w-0 overflow-hidden">
          {children}
        </div>

      </div>
    </DefaultLayout>
  );
}

import React from "react";
import { useRouter } from "next/router";
import NextLink from "next/link";
import { Listbox, ListboxItem } from "@heroui/listbox";
import DefaultLayout from "@/layouts/default";

const NAV_ITEMS = [
  { key: "flights", label: "Flights",  href: "/admin/flights",        color: "#d4a843" },
  { key: "videos",  label: "Videos",   href: "/admin/flights/videos",  color: "#60a5fa" },
  { key: "audio",   label: "Audio",    href: "/admin/flights/audio",   color: "#a78bfa" },
];

function activeKey(pathname: string): string {
  if (pathname.includes("audio"))  return "audio";
  if (pathname.includes("videos")) return "videos";
  return "flights";
}

export default function FlyingAdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const active = activeKey(router.pathname);

  return (
    <DefaultLayout>
      <div className="flex flex-col md:flex-row h-[calc(100vh-4rem)]">

        {/* ── Mobile top tab bar ──────────────────────────────────────── */}
        <nav className="md:hidden flex items-center border-b border-darkBorder bg-darkSurface flex-shrink-0 px-1">
          {NAV_ITEMS.map((item) => {
            const isActive = item.key === active;
            return (
              <NextLink
                key={item.key}
                href={item.href}
                className="flex-shrink-0 flex items-center gap-1.5 px-4 py-3 text-xs font-mono border-b-2 transition-colors whitespace-nowrap"
                style={{
                  borderBottomColor: isActive ? item.color : "transparent",
                  color: isActive ? item.color : "#6b7280",
                }}
              >
                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: item.color }} />
                {item.label}
              </NextLink>
            );
          })}
        </nav>

        {/* ── Desktop sidebar ─────────────────────────────────────────── */}
        <aside className="hidden md:flex w-48 flex-shrink-0 border-r border-darkBorder flex-col py-4 bg-darkSurface">
          <p className="px-4 text-[10px] uppercase tracking-widest text-gray-500 mb-2 font-mono">
            Flying
          </p>

          <Listbox
            aria-label="Flying admin navigation"
            variant="flat"
            selectionMode="single"
            selectedKeys={new Set([active])}
            disallowEmptySelection
            classNames={{ base: "px-2", list: "gap-1" }}
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
                      isActive ? "bg-opacity-10" : "hover:bg-white/5",
                    ].join(" "),
                    title: "text-sm font-mono",
                  }}
                  style={isActive ? { backgroundColor: item.color + "22", color: item.color } : { color: "#9ca3af" }}
                  startContent={
                    <span
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ backgroundColor: isActive ? item.color : item.color + "55" }}
                    />
                  }
                >
                  {item.label}
                </ListboxItem>
              );
            })}
          </Listbox>
        </aside>

        {/* ── Page content ────────────────────────────────────────────── */}
        <div className="flex-1 min-w-0 overflow-auto bg-darkBg">
          {children}
        </div>

      </div>
    </DefaultLayout>
  );
}

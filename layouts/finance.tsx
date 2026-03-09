import React from "react";
import { useRouter } from "next/router";
import NextLink from "next/link";
import { Listbox, ListboxItem } from "@heroui/listbox";
import { Divider } from "@heroui/divider";
import DefaultLayout from "@/layouts/default";

const FINANCE_COLOR = "#10b981"; // emerald

const NAV_ITEMS = [
  { key: "dashboard",    label: "Dashboard",    href: "/finance" },
  { key: "transactions", label: "Transactions", href: "/finance/transactions" },
  { key: "recurring",    label: "Recurring",    href: "/finance/recurring" },
  { key: "goals",        label: "Goals",        href: "/finance/goals" },
];

function activeKey(pathname: string): string {
  if (pathname === "/finance") return "dashboard";
  if (pathname.includes("transactions")) return "transactions";
  if (pathname.includes("recurring"))    return "recurring";
  if (pathname.includes("goals"))        return "goals";
  return "dashboard";
}

export default function FinanceLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const active = activeKey(router.pathname);

  return (
    <DefaultLayout>
      <div className="flex flex-col md:flex-row h-[calc(100vh-4rem)]">

        {/* ── Mobile top tab bar ──────────────────────────────────────────── */}
        <nav className="md:hidden flex items-center overflow-x-auto border-b border-gray-200 dark:border-darkBorder bg-white dark:bg-darkSurface flex-shrink-0 px-1">
          {NAV_ITEMS.map((item) => {
            const isActive = item.key === active;
            return (
              <NextLink
                key={item.key}
                href={item.href}
                className="flex-shrink-0 flex items-center gap-1.5 px-3 py-3 text-xs font-medium border-b-2 transition-colors whitespace-nowrap"
                style={{
                  borderBottomColor: isActive ? FINANCE_COLOR : "transparent",
                  color: isActive ? FINANCE_COLOR : undefined,
                }}
              >
                <span
                  className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: FINANCE_COLOR }}
                />
                {item.label}
              </NextLink>
            );
          })}
        </nav>

        {/* ── Desktop sidebar ─────────────────────────────────────────────── */}
        <aside className="hidden md:flex w-48 flex-shrink-0 border-r border-gray-200 dark:border-darkBorder flex-col py-4 bg-white dark:bg-darkSurface">
          <p className="px-4 text-[10px] uppercase tracking-widest text-gray-400 dark:text-gray-500 mb-2 font-medium">
            Finance
          </p>

          <Listbox
            aria-label="Finance navigation"
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
                      isActive ? "bg-opacity-10" : "hover:bg-gray-100 dark:hover:bg-white/5",
                    ].join(" "),
                    title: "text-sm font-medium",
                  }}
                  style={isActive ? { backgroundColor: FINANCE_COLOR + "22", color: FINANCE_COLOR } : undefined}
                  startContent={
                    <span
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ backgroundColor: isActive ? FINANCE_COLOR : FINANCE_COLOR + "66" }}
                    />
                  }
                >
                  {item.label}
                </ListboxItem>
              );
            })}
          </Listbox>

          <Divider className="my-3 mx-4 w-auto" />

          <p className="px-4 text-[10px] uppercase tracking-widest text-gray-400 dark:text-gray-500 mb-2 font-medium">
            Quick Add
          </p>
          <div className="px-2 flex flex-col gap-1">
            <NextLink
              href="/finance/transactions?new=1"
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors hover:bg-gray-100 dark:hover:bg-white/5"
              style={{ color: FINANCE_COLOR }}
            >
              <span className="text-base leading-none">+</span>
              Transaction
            </NextLink>
            <NextLink
              href="/finance/recurring?new=1"
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors hover:bg-gray-100 dark:hover:bg-white/5"
              style={{ color: FINANCE_COLOR }}
            >
              <span className="text-base leading-none">+</span>
              Recurring
            </NextLink>
            <NextLink
              href="/finance/goals?new=1"
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors hover:bg-gray-100 dark:hover:bg-white/5"
              style={{ color: FINANCE_COLOR }}
            >
              <span className="text-base leading-none">+</span>
              Goal
            </NextLink>
          </div>
        </aside>

        {/* ── Page content ────────────────────────────────────────────────── */}
        <div className="flex-1 min-w-0 overflow-hidden bg-white dark:bg-darkBg">
          {children}
        </div>

      </div>
    </DefaultLayout>
  );
}

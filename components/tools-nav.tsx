import React from "react";
import NextLink from "next/link";
import { Listbox, ListboxItem } from "@heroui/listbox";
import { Divider } from "@heroui/divider";

export type ToolKey = "admin" | "inventory" | "finance" | "flights";

const TOOLS: { key: ToolKey; label: string; href: string }[] = [
  { key: "admin",     label: "Agent",     href: "/admin" },
  { key: "inventory", label: "Inventory", href: "/inventory" },
  { key: "finance",   label: "Finance",   href: "/finance" },
  { key: "flights",   label: "Flights",   href: "/admin/flights" },
];

export function ToolsNav({ current }: { current: ToolKey }) {
  const items = TOOLS.filter((t) => t.key !== current);
  return (
    <>
      <Divider className="my-3 mx-4 w-auto" />
      <p className="px-4 text-[10px] uppercase tracking-widest text-gray-400 dark:text-gray-500 mb-2 font-medium">
        Tools
      </p>
      <Listbox
        aria-label="Cross-tool navigation"
        variant="flat"
        classNames={{ base: "px-2", list: "gap-1" }}
      >
        {items.map((item) => (
          <ListboxItem
            key={item.key}
            as={NextLink}
            href={item.href}
            textValue={item.label}
            classNames={{
              base: "rounded-lg px-3 py-2 transition-colors hover:bg-gray-100 dark:hover:bg-white/5 text-gray-500 dark:text-gray-400",
              title: "text-sm font-medium",
            }}
          >
            {item.label}
          </ListboxItem>
        ))}
      </Listbox>
    </>
  );
}

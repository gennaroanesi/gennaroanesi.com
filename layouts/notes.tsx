import React from "react";
import { useRouter } from "next/router";
import NextLink from "next/link";
import { Listbox, ListboxItem } from "@heroui/listbox";
import { Divider } from "@heroui/divider";
import DefaultLayout from "@/layouts/default";

export const NOTES_COLOR = "#7c6f9f";

const NAV_ITEMS = [
  { key: "projects",  label: "Projects",  href: "/notes/projects",  icon: "🎯" },
  { key: "areas",     label: "Areas",     href: "/notes/areas",     icon: "🔁" },
  { key: "resources", label: "Resources", href: "/notes/resources", icon: "📚" },
  { key: "archives",  label: "Archives",  href: "/notes/archives",  icon: "🗄️" },
];

function activeKey(pathname: string): string {
  if (pathname.includes("projects"))  return "projects";
  if (pathname.includes("areas"))     return "areas";
  if (pathname.includes("resources")) return "resources";
  if (pathname.includes("archives"))  return "archives";
  return "projects";
}

export default function NotesLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const active = activeKey(router.pathname);

  return (
    <DefaultLayout>
      <div className="flex flex-row w-full min-h-screen">
        {/* Sidebar */}
        <aside className="hidden md:flex flex-col w-52 shrink-0 border-r border-gray-100 dark:border-gray-800 pt-8 px-3 gap-4">
          <NextLink href="/notes" className="px-3 block">
            <h2
              className="text-xs font-bold uppercase tracking-widest mb-1"
              style={{ color: NOTES_COLOR }}
            >
              Notes
            </h2>
            <p className="text-[10px] text-gray-400">PARA · S3</p>
          </NextLink>
          <Divider />
          <Listbox
            aria-label="Notes navigation"
            selectedKeys={[active]}
            selectionMode="single"
            itemClasses={{
              base: "rounded-md px-3 py-2 data-[hover=true]:bg-gray-50 dark:data-[hover=true]:bg-gray-800/50",
              title: "text-sm font-medium text-gray-700 dark:text-gray-300",
            }}
          >
            {NAV_ITEMS.map((item) => (
              <ListboxItem
                key={item.key}
                href={item.href}
                startContent={<span className="text-base">{item.icon}</span>}
                style={active === item.key ? { color: NOTES_COLOR } : {}}
              >
                {item.label}
              </ListboxItem>
            ))}
          </Listbox>
          <Divider />
          <NextLink
            href="/tasks"
            className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
          >
            → Tasks
          </NextLink>
        </aside>

        {/* Main content */}
        <main className="flex-1 min-w-0 p-6">{children}</main>
      </div>
    </DefaultLayout>
  );
}

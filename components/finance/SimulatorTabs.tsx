import NextLink from "next/link";
import { useRouter } from "next/router";
import { FINANCE_COLOR } from "./_shared";

const SIMULATOR_TABS = [
  { key: "cashflow", label: "Cashflow", href: "/finance/simulator/cashflow" },
  { key: "planning", label: "Long-term planning", href: "/finance/simulator/planning" },
];

export default function SimulatorTabs() {
  const router = useRouter();
  const active = SIMULATOR_TABS.find((t) => router.pathname.endsWith(t.key))?.key;
  return (
    <div className="flex items-center gap-1 border-b border-gray-200 dark:border-darkBorder mb-4 overflow-x-auto">
      {SIMULATOR_TABS.map((t) => {
        const isActive = t.key === active;
        return (
          <NextLink
            key={t.key}
            href={t.href}
            className="flex-shrink-0 px-4 py-2 text-xs font-semibold border-b-2 transition-colors -mb-px whitespace-nowrap"
            style={{
              borderBottomColor: isActive ? FINANCE_COLOR : "transparent",
              color: isActive ? FINANCE_COLOR : undefined,
            }}
          >
            {t.label}
          </NextLink>
        );
      })}
    </div>
  );
}

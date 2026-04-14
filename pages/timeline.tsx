import React, { useMemo, useState } from "react";
import DefaultLayout from "@/layouts/default";

type Category = "aviation" | "dev" | "work" | "music" | "photo" | "life";

type Project = {
  date: string; // YYYY-MM (used for sorting + display)
  title: string;
  description: string;
  category: Category;
  link?: string;
};

const CATEGORIES: Record<Category, { label: string; color: string }> = {
  aviation: { label: "Aviation", color: "#DEBA02" },
  dev: { label: "Personal Projects", color: "#60a5fa" },
  work: { label: "Work", color: "#587D71" },
  music: { label: "Music", color: "#c084fc" },
  photo: { label: "Photo", color: "#d97757" },
  life: { label: "Life", color: "#a78bfa" },
};

// Edit freely. Add/remove entries; they're sorted by date descending at render time.
const PROJECTS: Project[] = [
  {
    date: "2026-03",
    title: "Instrument Checkride",
    description: "Passed at Lubbock, TX.",
    category: "aviation",
  },
  {
    date: "2026-03",
    title: "Created 91 Dispatcher",
    description: "A safety-oriented aviation app.",
    category: "dev",
    link: "https://91dispatcher.ai",
  },
  {
    date: "2026-02",
    title: "gennaroanesi.com 'rewrite' with Claude Code",
    description:
      "Next.js + Amplify Gen2. Flight log, photo hub, this timeline.",
    category: "dev"
  },
  {
    date: "2025-12",
    title: "Mountain Flying course",
    description:
      "Flying on the rockies with approaches at Telluride, Aspen and Eagle.",
    category: "aviation",
  },
  {
    date: "2025-10",
    title: "Started leading a team of Data Scientists at Meta supporting Sales AI",
    description:
      "Extensive use of Claude, Gemini and Llama to boost efficiency and deliver data insights to unlock key product decisions.",
    category: "work",
  },
  {
    date: "2025-08",
    title: "Private Pilot Checkride",
    description: "Passed at Lubbock, TX.",
    category: "aviation",
  },
  {
    date: "2025-02",
    title: "Created Paid Messaging Long-Range Plan",
    description:
      "Outlined how a nascent product could achieve multi-billion dollar revenue in 5–10 years. Direct conversations with CRO and multiple product, sales, and marketing VPs.",
    category: "work",
  },
  {
    date: "2024-04",
    title: "Created 0->1 Sales Pitch Recommendation System",
    description:
      "Created a ranking metric to compare fundamentally different products; elected the best based on sales capacity and delivered pitch recommendations with personalized insights to improve adoption rates. This work is now staffed by a full DS team and is one of the main drivers of sales conversations with clients.",
    category: "work",
  },
];

const ALL = new Set<Category>(Object.keys(CATEGORIES) as Category[]);

function formatDate(ym: string) {
  const [y, m] = ym.split("-");
  const month = new Date(Number(y), Number(m) - 1).toLocaleString("en-US", {
    month: "short",
  });
  return `${month} ${y}`;
}

export default function ProjectsPage() {
  const [active, setActive] = useState<Set<Category>>(new Set(ALL));

  const sorted = useMemo(
    () => [...PROJECTS].sort((a, b) => (a.date < b.date ? 1 : -1)),
    [],
  );
  const filtered = sorted.filter((p) => active.has(p.category));

  const toggle = (c: Category) => {
    setActive((prev) => {
      // If this category is the only one selected, clicking it again resets to All.
      if (prev.size === 1 && prev.has(c)) return new Set(ALL);
      // Otherwise, selecting a category shows only that category.
      return new Set([c]);
    });
  };

  const showAll = () => setActive(new Set(ALL));

  return (
    <DefaultLayout>
      <div
        className="flex flex-col px-6 sm:px-10 pt-8 sm:pt-12"
        style={{ height: "calc(100dvh - 4rem)" }}
      >
        <div className="max-w-3xl mx-auto w-full flex flex-col min-h-0 flex-1">
          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-medium text-purple dark:text-rose mb-3 flex-shrink-0">
            Timeline
          </h1>
          <p className="text-base text-purple/70 dark:text-rose/70 mb-6 sm:mb-8 flex-shrink-0">
            A running log of what I've been building, flying, shooting, and
            playing.
          </p>

          {/* Category filter */}
          <div className="flex flex-wrap items-center gap-2 mb-6 sm:mb-8 flex-shrink-0">
            <button
              type="button"
              onClick={showAll}
              className={`px-3 py-1.5 text-xs uppercase tracking-widest border transition-colors ${
                active.size === ALL.size
                  ? "border-purple dark:border-rose text-purple dark:text-rose"
                  : "border-darkBorder text-purple/50 dark:text-rose/50 hover:text-purple dark:hover:text-rose"
              }`}
            >
              All
            </button>
            {(Object.keys(CATEGORIES) as Category[]).map((c) => {
              const cat = CATEGORIES[c];
              const on = active.has(c) && active.size !== ALL.size;
              // Treat "all on" as a neutral state so individual chips aren't "lit" by default.
              const allOn = active.size === ALL.size;
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => toggle(c)}
                  className="px-3 py-1.5 text-xs uppercase tracking-widest border transition-colors"
                  style={
                    on
                      ? { color: cat.color, borderColor: cat.color }
                      : allOn
                        ? {
                            color: cat.color,
                            borderColor: "transparent",
                            backgroundColor: "rgba(255,255,255,0.04)",
                          }
                        : { opacity: 0.4 }
                  }
                >
                  <span
                    className="inline-block h-2 w-2 rounded-full mr-2 align-middle"
                    style={{ backgroundColor: cat.color }}
                  />
                  {cat.label}
                </button>
              );
            })}
          </div>

          {/* Timeline */}
          <ol className="relative flex-1 min-h-0 overflow-y-auto pb-8 scrollbar-hide">
            <div className="absolute left-[7px] top-2 bottom-2 w-px bg-darkBorder" />

            {filtered.map((p, i) => {
              const cat = CATEGORIES[p.category];
              return (
                <li key={`${p.date}-${p.title}-${i}`} className="relative pl-8 pb-8 sm:pb-10 last:pb-0">
                  <span
                    className="absolute left-0 top-[6px] h-[15px] w-[15px] rounded-full ring-4 ring-gray-50 dark:ring-darkBg"
                    style={{ backgroundColor: cat.color }}
                    aria-hidden
                  />

                  <div className="flex items-center justify-between gap-3 mb-1">
                    <span className="font-mono text-xs uppercase tracking-widest text-purple/60 dark:text-rose/60">
                      {formatDate(p.date)}
                    </span>
                    <span
                      className="text-[10px] sm:text-xs uppercase tracking-widest"
                      style={{ color: cat.color }}
                    >
                      {cat.label}
                    </span>
                  </div>

                  <h3 className="text-lg sm:text-xl font-medium text-purple dark:text-rose leading-snug">
                    {p.link ? (
                      <a
                        href={p.link}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:text-gold transition-colors"
                      >
                        {p.title}
                      </a>
                    ) : (
                      p.title
                    )}
                  </h3>
                  <p className="mt-1 text-sm sm:text-base text-purple/75 dark:text-rose/75 leading-relaxed">
                    {p.description}
                  </p>
                </li>
              );
            })}

            {filtered.length === 0 && (
              <li className="pl-8 text-sm text-purple/60 dark:text-rose/60">
                No projects in this filter.
              </li>
            )}
          </ol>
        </div>
      </div>
    </DefaultLayout>
  );
}

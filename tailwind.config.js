import { heroui } from "@heroui/theme";

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./layouts/**/*.{js,ts,jsx,tsx,mdx}",
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./node_modules/@heroui/theme/dist/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      // Without this, `font-sans` / `font-mono` keep Tailwind's built-in system
      // stacks — which is exactly how the site spent a long time loading a web
      // font that never rendered: globals.css set the font on `html`, while
      // `<body class="font-sans">` overrode it for everything inside. The
      // variables come from next/font (config/fonts.ts) via _app.tsx, which is
      // the only place the loader runs on the Pages Router.
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      colors: {
        primary:    "#BCABAE",
        secondary:  "#4e5e53",
        text:       "#aca29c",
        // Dark mode ramp — more contrast between layers
        darkBg:     "#1e1e2e",   // page background
        darkSurface:"#27273a",   // sidebar, card bg
        darkElevated:"#31314a",  // inputs, table header, raised panels
        darkBorder: "#3d3d58",   // borders
        // Keep legacy names pointing to new values
        darkPurple: "#27273a",
        purple:     "#31314a",
        rose:       "#BCABAE",
        green:      "#587D71",
        gold:       "#DEBA02",
        // Semantic tokens (mirror of lib/colors.ts — keep in sync). Meaning, not
        // brand: positive=gain/income, negative=loss/expense, warning=pending.
        positive:   "#22c55e",
        negative:   "#ef4444",
        warning:    "#f59e0b",
        financeAccent: "#10b981",
      },
    },
  },
  darkMode: "class",
  plugins: [
    heroui({
      defaultTheme: "dark",
      themes: {
        light: {
          colors: {
            primary: "#323243",
          },
        },
        dark: {
          colors: {
            primary: "#3D3D52",
          },
        },
      },
    }),
  ],
};

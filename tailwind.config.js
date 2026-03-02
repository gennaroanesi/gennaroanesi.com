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

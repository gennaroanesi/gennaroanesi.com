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
        primary: "#BCABAE",
        secondary: "#4e5e53",
        text: "#aca29c",
        darkPurple: "#323243",
        purple: "#3D3D52",
        rose: "#BCABAE",
        green: "#587D71",
        gold: "#DEBA02",
      },
    },
  },
  plugins: [
    heroui({
      defaultTheme: "light",
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

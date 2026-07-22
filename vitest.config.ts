import { defineConfig } from "vitest/config";
import { resolve } from "path";

// Unit tests target the pure finance logic (no React, no DB). Node env is enough;
// the `@/` alias mirrors tsconfig so imports resolve the same as in the app.
export default defineConfig({
  resolve: {
    alias: { "@": resolve(__dirname, ".") },
  },
  test: {
    environment: "node",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", ".next/**", "out/**"],
  },
});

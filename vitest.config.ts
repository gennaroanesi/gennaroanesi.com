import { defineConfig } from "vitest/config";
import { resolve } from "path";

// Unit tests target the pure finance logic (no React, no DB). Node env is enough;
// the `@/` alias mirrors tsconfig so imports resolve the same as in the app.
//
// NOTE: vitest is intentionally NOT in package.json devDependencies. Adding any
// package to this repo's lockfile with npm 10.x produces a package-lock.json
// that `npm ci` then rejects as out-of-sync (an npm resolver bug on the deep
// AWS-SDK/CDK dependency tree — it drops random transitive deps like
// fast-xml-parser). Keeping vitest out of the lock keeps the Amplify build
// (npm ci) green. To run the tests locally:
//     npm install -D vitest@^2 --legacy-peer-deps   # local only; don't commit the lock churn
//     npm test
// The test files are excluded from tsconfig so `next build` doesn't typecheck
// their `vitest` imports.
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

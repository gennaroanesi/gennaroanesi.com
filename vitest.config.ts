import { defineConfig } from "vitest/config";
import { resolve } from "path";

// Unit tests target the pure finance logic (no React, no DB). Node env is enough;
// the `@/` alias mirrors tsconfig so imports resolve the same as in the app.
//
// vitest IS in package.json devDependencies (since 2026-07) so `npm ci && npm test`
// works in CI. LOCKFILE GOTCHA when adding/updating deps: npm 10.x's resolver
// chokes on this repo's CDK tree ("Cannot read properties of null (reading
// 'resolve')") and its lock-only mode drops @aws-cdk/cli-plugin-contract — a
// peer dep of @aws-cdk/toolkit-lib that `npm ci` then reports as "Missing:
// ... from lock file". Working recipe:
//     npx npm@11 install --package-lock-only --legacy-peer-deps
//     # then, if npm ci complains about @aws-cdk/cli-plugin-contract, re-add
//     # its packages[] entry (version 2.182.2, peer: true) to package-lock.json
// Always validate with `npm ci` (in a scratch dir) before pushing — the
// Amplify build runs npm ci and a bad lock breaks the deploy.
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

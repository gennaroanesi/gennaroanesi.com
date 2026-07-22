import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

// Lean, correctness-first flat config. The point is to catch real bugs — chiefly
// Rules of Hooks (which would have caught the React #310 crash) — without
// drowning a large pre-existing codebase in style noise. Style/formatting rules
// are intentionally relaxed; add stricter rules incrementally.

// The source has `eslint-disable @next/next/no-img-element` comments but the
// Next ESLint plugin isn't installed, so ESLint errors that the rule is
// undefined. Register a no-op stub so those directives resolve. (Swap for
// @next/eslint-plugin-next if we ever want the real Next rules.)
const nextStub = { rules: { "no-img-element": { create: () => ({}) } } };

export default tseslint.config(
  {
    ignores: [
      ".next/**", "out/**", "node_modules/**", "public/**",
      ".amplify/**", "amplify/**", "doc/**",
      "**/*.d.ts", "next-env.d.ts", "**/*.config.{js,cjs,mjs}",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,js,jsx,mjs,cjs}"],
    plugins: { "react-hooks": reactHooks, "@next/next": nextStub },
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // The rules worth having lint for at all:
      "react-hooks/rules-of-hooks": "error",   // catches the #310 hooks-order crash
      "react-hooks/exhaustive-deps": "warn",

      // Relax the noisy rules that would flag thousands of existing lines
      // without indicating real defects. Tighten later, file by file.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none",
      }],
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-unused-expressions": ["error", {
        allowShortCircuit: true, allowTernary: true, allowTaggedTemplates: true,
      }],
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-prototype-builtins": "warn",
      "no-irregular-whitespace": "warn",
      "prefer-const": "warn",
    },
  },
);

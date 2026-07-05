import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // ── Global ignores ────────────────────────────────────────────────
  {
    ignores: [
      "dist/**",
      "web-dist/**",
      "server/dist/**",
      "node_modules/**",
      "server/node_modules/**",
      "server/prisma/migrations/**",
      "*.config.ts",
      "*.config.mjs",
      "*.config.js",
      "scripts/**",
    ],
  },

  // ── Base recommended rules (JS) ───────────────────────────────────
  js.configs.recommended,

  // ── TypeScript recommended rules ──────────────────────────────────
  ...tseslint.configs.recommended,

  // ── Project-wide customizations ───────────────────────────────────
  {
    rules: {
      // TypeScript — relaxed for pragmatism
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-non-null-assertion": "off",

      // General quality
      "no-console": "warn",
      "no-debugger": "warn",
      "no-duplicate-imports": "error",
      "prefer-const": "warn",
      "no-var": "error",
      eqeqeq: ["warn", "smart"],
    },
  },

  // ── Frontend (React / Vite) overrides ─────────────────────────────
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      // Allow void in event handlers / effects
      "@typescript-eslint/no-floating-promises": "off",
      // React components often use any for props during prototyping
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },

  // ── Backend (Fastify) overrides ───────────────────────────────────
  {
    files: ["server/src/**/*.ts"],
    rules: {
      // Top-level await and process usage are normal in server code
      "@typescript-eslint/no-require-imports": "off",
      // Server code legitimately uses any for request shapes, etc.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
);

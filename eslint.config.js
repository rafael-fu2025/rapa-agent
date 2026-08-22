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
      // console.error/warn are allowed (error boundaries, expected
      // failures); bare console.log/debug stays flagged.
      "no-console": ["warn", { allow: ["error", "warn"] }],
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
      // The server logs operational events to stdout/stderr by design —
      // request lifecycle, tool execution, startup. Not debug leftovers.
      "no-console": "off",
    },
  },

  // ── Test files (last so it wins over the app blocks above) ────────
  // Test fixtures legitimately use loose types and console output for
  // debugging; production strictness doesn't apply.
  {
    files: [
      "**/*.test.ts",
      "**/*.test.tsx",
      "server/src/**/_test/**/*.ts",
      "src/**/__tests__/**/*.ts",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
    },
  },

  // ── Ambient declarations (last so it wins over the app blocks above) ──
  {
    files: ["**/*.d.ts"],
    rules: {
      // Module augmentation frequently widens library types to any.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },

  // ── One-off server maintenance scripts (not product code) ─────────
  {
    files: ["server/src/scripts/**/*.ts"],
    rules: {
      // Migration / verification scripts parse untyped DB rows and JSON.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);

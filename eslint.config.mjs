import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [
  ...nextVitals,
  ...nextTs,
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "next-env.d.ts",
    ],
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // UI code reaches data only through services in src/server, never the schema directly.
    files: ["src/app/**/*.{ts,tsx}", "src/components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/server/db/schema", "drizzle-orm", "drizzle-orm/*"],
              message: "Use a service in src/server instead.",
            },
          ],
        },
      ],
    },
  },
  {
    // Domain code must stay framework-agnostic so it can serve web, API and future mobile clients.
    files: ["src/server/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["next", "next/*", "react", "react-dom"],
              message: "src/server must not depend on Next.js or React.",
            },
            { group: ["@/app/*", "@/components/*"], message: "src/server must not import UI code." },
          ],
        },
      ],
    },
  },
];

export default config;

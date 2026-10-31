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

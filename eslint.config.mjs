import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Shape limits fallow doesn't measure (it counts per function, not nesting/params/file).
    files: ["app/**", "components/**", "lib/**"],
    rules: {
      "max-depth": ["warn", 4],
      "max-params": ["warn", 5],
      "max-lines": ["warn", { max: 500, skipBlankLines: true, skipComments: true }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Agent tooling scratch/memory (gitignored, not app source).
    ".remember/**",
    // Claude Design handoff bundle kept as a reference, not app source.
    "data_log/**",
  ]),
]);

export default eslintConfig;

import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["**/dist/", "**/node_modules/", "**/coverage/", "data/"]),

  js.configs.recommended,
  tseslint.configs.recommended,

  {
    files: ["apps/api/**/*.ts", "packages/shared/**/*.ts", "*.js", "apps/web/vite.config.ts"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
  },

  // Guardrail from CLAUDE.md: only apps/api/src/llm may import the Gemini SDK.
  {
    files: ["**/*.{ts,tsx,js}"],
    ignores: ["apps/api/src/llm/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@google/genai", "@google/genai/*", "@google/generative-ai"],
              message: "Only apps/api/src/llm may import the Gemini SDK. Use the LlmProvider.",
            },
          ],
        },
      ],
    },
  },
]);

import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["src/**/*.ts"],
  })),
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Existing code uses `any` where Prisma/ffprobe JSONB payloads are intentionally
      // dynamic (AGENTS.md "11. Database Strategy"); typing these is a v2 concern.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
);

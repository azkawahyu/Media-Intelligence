import { defineConfig } from "vitest/config";

/**
 * Test isolation (TESTING.md §63/§65): the integration suites share one
 * PostgreSQL database (`TEST_DATABASE_URL`) and clear tables between cases, so
 * they must not run in parallel against each other. Serializing files keeps the
 * pure unit suites fast while making the DB-backed ones deterministic.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Integration tests share one test database, so test files run one at a time.
    fileParallelism: false,
  },
});

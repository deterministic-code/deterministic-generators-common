import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    testTimeout: 40_000,
    coverage: {
      provider: "v8",
      include: ["**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "types.ts",
        "test/**",
        "vitest.config.ts",
        "validators/engines.ts",
      ],
      reporter: ["text"],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});

import { defineConfig } from "vitest/config";

const conditions = ["@llm-router/source", "node", "import", "default"];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
  },
});

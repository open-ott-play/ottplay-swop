/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    pool: "forks",
    include: ["src/test/**/*.test.ts"],
  },
});

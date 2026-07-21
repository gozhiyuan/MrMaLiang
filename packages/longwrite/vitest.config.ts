import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Figure/PDF fixture setup is deterministic but can exceed Vitest's
    // five-second default when the full suite shares one local filesystem.
    testTimeout: 15_000,
  },
});

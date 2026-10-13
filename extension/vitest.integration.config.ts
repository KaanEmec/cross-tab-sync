import { defineConfig } from "vitest/config";

// Real Go server + real TypeScript client. Files are named *.integration.ts so that the unit
// config (test/**/*.test.{ts,js}) never picks them up.
export default defineConfig({
  test: {
    include: ["test/integration/**/*.integration.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});

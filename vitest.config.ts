import { defineConfig } from "vitest/config"
import { resolve } from "node:path"

// Minimal Vitest config for the pure `lib/selection.ts` module. The `@` alias
// mirrors tsconfig.json paths (`@/*` → repo root). selection.ts only imports
// `@/lib/hotel-data` (plain data), so the node environment is sufficient — no
// jsdom/React env needed.
export default defineConfig({
  resolve: {
    alias: { "@": resolve(__dirname, ".") },
  },
  test: {
    environment: "node",
  },
})

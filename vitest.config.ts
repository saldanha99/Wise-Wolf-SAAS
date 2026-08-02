import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Testes de componente. A lógica pura continua coberta por Deno em
// scripts/tests/ — este runner é para o que precisa de DOM.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: [
      "src/**/*.test.{ts,tsx}",
      "components/**/*.test.{ts,tsx}",
      "apps/**/*.test.{ts,tsx}",
    ],
  },
});

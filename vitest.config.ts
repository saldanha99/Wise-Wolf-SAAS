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
    // `lib/supabase-config.ts` aborta o boot sem estas duas — e aborta de novo se a
    // URL for da nuvem (`.supabase.co`), que é a trava contra buildar apontando para
    // fora da VPS. Sem os valores aqui, qualquer teste de regra em lib/ que importe
    // um módulo com supabase na cadeia falhava no import, antes do primeiro caso.
    // Host fictício de propósito: teste não fala com banco nenhum.
    env: {
      VITE_SUPABASE_URL: "http://localhost:54321",
      VITE_SUPABASE_ANON_KEY: "anon-key-de-teste",
    },
    // lib/**/*.test.ts entra porque regra de negócio pura (navegação, datas)
    // mora em lib/ e não tem .tsx — ficava fora do `npm test` sem ninguém notar.
    // apps/ cobre o funil standalone do Wolfie, que vive fora de src/.
    include: [
      "src/**/*.test.{ts,tsx}",
      "components/**/*.test.{ts,tsx}",
      "apps/**/*.test.{ts,tsx}",
      "lib/**/*.test.ts",
      "remotion/**/*.test.{ts,tsx}",
    ],
  },
});

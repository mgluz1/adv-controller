import { defineConfig } from "@playwright/test";

// O E2E usa servidor PRÓPRIO, em porta dedicada e SEM banco (DATABASE_URL/BETTER_AUTH_SECRET vazios
// sobrepõem qualquer .env.local): os testes nunca tocam o Neon. A API é interceptada nos próprios testes.
const PORT = 3100;
export default defineConfig({
  testDir: "tests/browser",
  use: { baseURL: `http://127.0.0.1:${PORT}`, headless: true, channel: "chrome" },
  webServer: {
    command: "npm run dev",
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    env: { PORT: String(PORT), DATABASE_URL: "", DATABASE_URL_UNPOOLED: "", BETTER_AUTH_SECRET: "" },
  },
  reporter: "list",
});

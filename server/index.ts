import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { openDatabase } from "./db.ts";
import { createApp } from "./app.ts";

// Node can read .env natively; ignore a missing file so the app runs with zero setup.
try {
  process.loadEnvFile?.(".env");
} catch {
  // no .env file — deterministic mode
}

const db = openDatabase();
const app = createApp(db);

const dist = "./dist";
if (existsSync(`${dist}/index.html`)) {
  app.use("/*", serveStatic({ root: dist }));
  app.get("*", serveStatic({ path: `${dist}/index.html` }));
} else {
  app.get("/", (c) =>
    c.text("API is running. Start the Vite dev server with `pnpm dev:web` and open http://localhost:5173"),
  );
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`garlic api listening on http://localhost:${info.port}`);
});

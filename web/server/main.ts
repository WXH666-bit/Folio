import { createApp } from "./app.js";
const { app } = await createApp();
const port = Number(process.env.FOLIO_WEB_PORT ?? 3210);
await app.listen({ port, host: "127.0.0.1" });
process.stdout.write(`\nFolio 文档工坊 → http://127.0.0.1:${port}\n独立 pi：项目根目录 pi/ · 应用数据：项目根目录 data/\n\n`);
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  if (closing) return; closing = true; void app.close().then(() => process.exit(0));
});

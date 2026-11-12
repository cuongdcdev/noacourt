import { loadConfig } from "./config.js";
import { createApp } from "./server.js";

const config = loadConfig();
const { app, close, keeper } = createApp(config);
const server = app.listen(config.port, config.host, () => {
  process.stdout.write(
    `Noa Court MCP listening on ${config.host}:${config.port}\n`,
  );
});
if (config.keeperEnabled) keeper.start();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () =>
    server.close(() => {
      close();
      process.exit(0);
    }),
  );

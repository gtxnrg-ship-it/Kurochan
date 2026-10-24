import "dotenv/config";
import { buildServer, validateServerConfiguration } from "./server.js";

const { host, port } = validateServerConfiguration();
const server = buildServer({
  workerEnabled:
    process.env.KUROCHAN_WORKER_ENABLED?.trim().toLowerCase() === "true",
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  server.log.info({ signal }, "Kuro-chan API shutdown requested");
  try {
    await server.close();
  } catch {
    // Avoid logging raw shutdown errors, which can contain provider details.
    server.log.error({ signal }, "Kuro-chan API shutdown failed");
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

try {
  await server.listen({ host, port });
  server.log.info({ host, port }, "Kuro-chan API listening");
} catch (error) {
  server.log.error({ err: error }, "Unable to start Kuro-chan API");
  process.exitCode = 1;
  await shutdown("startup-failure");
}

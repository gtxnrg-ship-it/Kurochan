import "dotenv/config";
import { buildServer, validateServerConfiguration } from "./server.js";

const { host, port } = validateServerConfiguration();
const server = buildServer({ workerEnabled: process.env.KUROCHAN_WORKER_ENABLED?.trim().toLowerCase() !== "false" });

try {
  await server.listen({ host, port });
  server.log.info({ host, port }, "Kuro-chan API listening");
} catch (error) {
  server.log.error({ err: error }, "Unable to start Kuro-chan API");
  process.exitCode = 1;
  await server.close();
}

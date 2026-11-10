import { SERVER_PORT } from "@baitnet/shared";
import { createApp } from "./app.js";
import { listenHost } from "./host.js";

const port = Number(process.env.PORT ?? SERVER_PORT);
const host = listenHost();
const app = createApp();
const onListen = () => {
  const env = app.data.getEnv();
  console.log(`BaitNet server on http://${host ?? "localhost"}:${port}  (registry ${env.registry.contractId}, ${env.network}; auth ${process.env.BAITNET_AUTH === "on" ? "on" : "off"})`);
  console.log("  GET /alerts /alerts/:id/evidence /check?chain=&address= /events (SSE) /flows/:alertId /responders /attestation /snapshot");
  void app.warm();
};
if (host) app.listen(port, host, onListen);
else app.listen(port, onListen);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => app.close(() => process.exit(0)));

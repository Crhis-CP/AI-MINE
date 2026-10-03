import { fetcherConfig } from "@amp/config";
import { createFetcher } from "./server.ts";

const { host, port } = fetcherConfig();
const server = createFetcher();
server.listen(port, host, () => console.log(JSON.stringify({ level: "info", msg: "fetcher started", port })));
server.on("error", () => {
  console.error("fetcher failed to listen");
  process.exitCode = 1;
});
const stop = () => server.close(() => process.exit(0));
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

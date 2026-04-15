import { spawn } from "node:child_process";

const run = (args) =>
  spawn("npm", args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });

const web = run(["run", "dev"]);
const server = run(["run", "dev:server"]);

const shutdown = () => {
  web.kill("SIGINT");
  server.kill("SIGINT");
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

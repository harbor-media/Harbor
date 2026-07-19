import { bootstrap } from "./boot.js";

const SHUTDOWN_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  const { shutdown } = await bootstrap();

  let shuttingDown = false;
  const handle = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;

    const timer = setTimeout(() => {
      process.exitCode = 1;
      process.exit();
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();

    void shutdown()
      .then(() => {
        clearTimeout(timer);
        process.exit(0);
      })
      .catch(() => {
        clearTimeout(timer);
        process.exit(1);
      });
    void signal;
  };

  process.on("SIGTERM", () => { handle("SIGTERM"); });
  process.on("SIGINT", () => { handle("SIGINT"); });
}

main().catch((error: unknown) => {
  // The logger may not exist yet if config validation failed, so this is the
  // one place a direct stderr write is correct.
  process.stderr.write(`Harbor failed to start: ${String(error)}\n`);
  process.exit(1);
});

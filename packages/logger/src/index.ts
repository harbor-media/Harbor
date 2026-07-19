import { pino, type DestinationStream, type Logger, type LoggerOptions as PinoOptions } from "pino";

export type { Logger } from "pino";

export interface LoggerOptions {
  level: string;
  production: boolean;
}

const REDACT_PATHS = [
  "password",
  "*.password",
  "token",
  "*.token",
  "secret",
  "*.secret",
  "apiKey",
  "*.apiKey",
  "DATABASE_URL",
  "*.DATABASE_URL",
  "provider.credentials.*",
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
];

export function createLogger(options: LoggerOptions, destination?: DestinationStream): Logger {
  const base: PinoOptions = {
    level: options.level,
    base: { service: "harbor" },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  };

  if (destination) return pino(base, destination);

  if (options.production) return pino(base);

  return pino({
    ...base,
    transport: {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname" },
    },
  });
}

export function forRequest(logger: Logger, requestId: string): Logger {
  return logger.child({ requestId });
}

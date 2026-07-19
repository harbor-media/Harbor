import { pino, type DestinationStream, type Logger, type LoggerOptions as PinoOptions } from "pino";

export type { Logger } from "pino";

export interface LoggerOptions {
  level: string;
  production: boolean;
}

// Pino's redact.paths matches literal key segments, not substrings.
// A path like "password" matches only keys named exactly "password", not "passwordHash" or "hashedPassword".
// Compound camelCase secret field names (sessionToken, accessToken, etc.) must be added explicitly below.
// Failure to add them here means they will appear unredacted in logs.
// Always add both the bare form and the one-level-nested wildcard form (e.g., "sessionToken" and "*.sessionToken").
const REDACT_PATHS = [
  "password",
  "*.password",
  "token",
  "*.token",
  "secret",
  "*.secret",
  "apiKey",
  "*.apiKey",
  "sessionToken",
  "*.sessionToken",
  "accessToken",
  "*.accessToken",
  "refreshToken",
  "*.refreshToken",
  "apiToken",
  "*.apiToken",
  "clientSecret",
  "*.clientSecret",
  "hashedPassword",
  "*.hashedPassword",
  "passwordHash",
  "*.passwordHash",
  "providerApiKey",
  "*.providerApiKey",
  "encryptionKey",
  "*.encryptionKey",
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

// This intentionally targets one concrete, documented risk: connection-string
// userinfo (e.g. postgresql://user:pass@host/db) leaking into free-text error
// messages written before or outside the pino logger, where key-based
// `redact` cannot apply. It is not a general-purpose secret scanner — do not
// extend it into a sprawling heuristic that tries to catch every conceivable
// secret shape, since that produces false positives on ordinary error text
// and gives a false sense of safety.
const URL_USERINFO_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s@/]+)@/g;

export function redactSecretsFromText(text: string): string {
  return text.replace(URL_USERINFO_PATTERN, (_match, scheme: string, userinfo: string) => {
    const masked = userinfo.includes(":") ? "***:***" : "***";
    return `${scheme}${masked}@`;
  });
}

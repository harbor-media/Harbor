import {
  pino,
  stdSerializers,
  type DestinationStream,
  type Logger,
  type LoggerOptions as PinoOptions,
} from "pino";

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

// The public invite-inspection route puts the raw invite token in the URL
// PATH (GET /api/v1/invitations/:token) rather than a request body, unlike
// every other bearer secret in Harbor (passwords, the register token). Fastify
// logs `method` + `url` for every request via its `req` serializer, so that
// token would otherwise land in access logs in plaintext. REDACT_PATHS above
// cannot help: pino's `redact.paths` matches object KEYS, not a substring
// inside a `url` string value. Deliberately scoped to one path segment after
// "/api/v1/invitations/" so it only touches the token-bearing inspect route —
// the admin list route (`GET /api/v1/invitations`, no trailing segment) and
// every unrelated URL pass through unchanged.
const INVITE_TOKEN_URL_PATTERN = /(\/api\/v1\/invitations\/)[^/?]+/;

export function redactUrl(url: string): string {
  return url.replace(INVITE_TOKEN_URL_PATTERN, "$1[redacted]");
}

// Fastify logs requests via `request.log.info({ req: request }, ...)`, where
// `request` is the Fastify request object (method/url/headers/host/ip/socket
// all proxy through to the raw Node request). When Fastify is constructed
// with `loggerInstance` (as Harbor's app.ts does), it merges its own default
// req/res/err serializers with whatever serializers this pino instance itself
// was built with — so overriding `req` here is what actually reaches
// Fastify's automatic request/response logs, not just calls made directly
// against this logger. `res` and `err` are restated to match Fastify's own
// defaults exactly (`{ statusCode }` and pino's standard error serializer)
// so this override changes ONLY what happens to `req.url` and leaves
// response/error logging behavior untouched.
interface SerializableRequest {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  host?: string;
  ip?: string;
  socket?: { remotePort?: number };
}

interface SerializableResponse {
  statusCode: number;
}

function reqSerializer(request: SerializableRequest): Record<string, unknown> {
  return {
    method: request.method,
    url: request.url === undefined ? undefined : redactUrl(request.url),
    version: request.headers?.["accept-version"],
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}

function resSerializer(reply: SerializableResponse): Record<string, unknown> {
  return { statusCode: reply.statusCode };
}

export function createLogger(options: LoggerOptions, destination?: DestinationStream): Logger {
  const base: PinoOptions = {
    level: options.level,
    base: { service: "harbor" },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    serializers: {
      req: reqSerializer,
      res: resSerializer,
      err: stdSerializers.err,
    },
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

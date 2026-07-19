export const ERROR_CODES = [
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "INTERNAL_ERROR",
  "SERVICE_UNAVAILABLE",
  "SETUP_ALREADY_COMPLETE",
  "RATE_LIMITED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
  };
}

export interface InstallationState {
  setupComplete: boolean;
  version: string;
}

export interface HealthStatus {
  status: "ok" | "degraded";
  version: string;
  uptimeSeconds: number;
}

export interface ReadinessStatus {
  ready: boolean;
  checks: {
    database: boolean;
    migrations: boolean;
    dataDirectory: boolean;
  };
}

export const API_PREFIX = "/api/v1";

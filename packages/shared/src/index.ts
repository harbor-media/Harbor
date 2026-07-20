export const ERROR_CODES = [
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "INTERNAL_ERROR",
  "SERVICE_UNAVAILABLE",
  "SETUP_ALREADY_COMPLETE",
  "RATE_LIMITED",
  "UNAUTHENTICATED",
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

// ============================================================================
// Authentication and User Types
// ============================================================================

/** User role in the Harbor installation. */
export type UserRole = "owner" | "administrator" | "user" | "guest";

/**
 * Public user API type.
 *
 * This type explicitly lists every field that is safe to expose through the API.
 * The database User type includes passwordHash, but that field is intentionally
 * omitted here. This explicit approach prevents future database columns from
 * silently appearing in API responses.
 */
export interface User {
  id: string;
  username: string;
  email: string | null;
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;
}

/** Information about the authenticated user and their session. */
export interface AuthContext {
  userId: string;
  username: string;
  role: UserRole;
  sessionId: string;
}

/**
 * The user identity attached to `request.user` by the authentication guard.
 * Deliberately excludes passwordHash and every other sensitive database
 * column: this is the only shape handlers and logs are ever allowed to see.
 */
export interface AuthenticatedUser {
  id: string;
  username: string;
  email: string | null;
  role: UserRole;
}

/** Request to create a new user account. */
export interface CreateUserRequest {
  username: string;
  email?: string;
  password: string;
  role?: UserRole;
}

/** Response when creating a user account. */
export interface CreateUserResponse {
  user: User;
}

/** Request to log in. */
export interface LoginRequest {
  username?: string;
  email?: string;
  password: string;
}

/** Response from a successful login. */
export interface LoginResponse {
  user: User;
  sessionId: string;
}

/** Response from password validation. */
export interface ValidatePasswordResponse {
  valid: boolean;
}

export const ERROR_CODES = [
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "INTERNAL_ERROR",
  "SERVICE_UNAVAILABLE",
  "SETUP_ALREADY_COMPLETE",
  "RATE_LIMITED",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "INVITATION_INVALID",
  "REGISTRATION_DISABLED",
  "METADATA_NOT_CONFIGURED",
  "METADATA_PROVIDER_UNAVAILABLE",
  "METADATA_PROVIDER_UNAUTHORIZED",
  "METADATA_KEY_UNREADABLE",
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
  registrationMode: RegistrationMode;
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

/** Request to log in. `identifier` accepts a username or an email. */
export interface LoginRequest {
  identifier: string;
  password: string;
}

/** Response from a successful login. */
export interface LoginResponse {
  user: AuthenticatedUser;
}

/** Request to complete first-run setup and create the owner account. */
export interface SetupRequest {
  language: string;
  serverName: string;
  username: string;
  email: string;
  password: string;
}

/** Response from completing first-run setup. */
export interface SetupResponse {
  user: AuthenticatedUser;
}

/** Response from password validation. */
export interface ValidatePasswordResponse {
  valid: boolean;
}

/**
 * The single source of truth for role precedence. Both requireRole (is the
 * caller's rank >= the required rank?) and the invite-granting rule (is the
 * requested role strictly below the creator's?) derive from this, so they
 * cannot drift.
 */
export function roleRank(role: UserRole): number {
  switch (role) {
    case "owner":
      return 3;
    case "administrator":
      return 2;
    case "user":
      return 1;
    case "guest":
      return 0;
  }
}

export type RegistrationMode = "disabled" | "invitation-only" | "open";

export type InvitationStatus = "active" | "spent" | "expired" | "revoked";

/** List-item shape returned by GET /invitations. Never carries a token. */
export interface Invitation {
  id: string;
  role: UserRole;
  emailBound: boolean;
  status: InvitationStatus;
  uses: number;
  maxUses: number;
  expiresAt: string | null;
  createdAt: string;
}

export interface CreateInvitationRequest {
  role: Exclude<UserRole, "owner">;
  email?: string;
  maxUses?: number;
  expiresInDays?: number;
}

export interface CreateInvitationResponse {
  invitation: Invitation;
  token: string;
  inviteUrl: string;
}

/** Public inspect response. A negative response is identical for invalid,
 *  spent, expired, revoked and never-existed tokens, so it cannot enumerate. */
export interface InviteInspection {
  valid: boolean;
  role: UserRole | null;
  emailBound: boolean;
}

export interface RegisterRequest {
  token?: string;
  username: string;
  email: string;
  password: string;
}

export interface RegisterResponse {
  user: AuthenticatedUser;
}

/**
 * What the API is willing to say about a configured provider. There is
 * deliberately no field carrying the key, masked or otherwise: a masked key
 * is still a partial credential disclosure, and the UI has no use for it.
 */
export interface MetadataConfigStatus {
  configured: boolean;
  enabled: boolean;
  language: string;
  lastVerifiedAt: string | null;
}

export interface SearchResultItem {
  id: string;
  type: "movie" | "series";
  title: string;
  year: number | null;
  overview: string | null;
  posterPath: string | null;
}

export interface SearchResponse {
  results: SearchResultItem[];
  /** True when served from Harbor's cache without contacting the provider.
   *  Exposed so the cache is observable in the UI and assertable in tests. */
  cached: boolean;
}

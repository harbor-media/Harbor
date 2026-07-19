import type { ApiErrorBody, ErrorCode } from "@harbor/shared";
import fp from "fastify-plugin";
import type { FastifyError, FastifyPluginAsync } from "fastify";

export class HarborError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "HarborError";
  }
}

function body(code: ErrorCode, message: string, requestId: string): ApiErrorBody {
  return { error: { code, message, requestId } };
}

const errorsPlugin: FastifyPluginAsync = async (fastify) => {
  // Fastify 5 defaults setErrorHandler's TError to `unknown`, because errors reaching
  // this handler are not guaranteed to be FastifyError-shaped: a plain `throw new
  // Error(...)` from application code, a database driver error, or an error thrown by a
  // dependency (@fastify/rate-limit, @fastify/static, etc.) can all land here without
  // ever being wrapped into a FastifyError. We instantiate <FastifyError> explicitly so
  // `.code`, `.statusCode`, and `.validation` are typed, but every access below still
  // treats them as optional — a future reader must not assume they are always populated.
  fastify.setErrorHandler<FastifyError>(function (error, request, reply) {
    if (error instanceof HarborError) {
      this.log.warn({ err: error, requestId: request.id }, "request rejected");
      void reply.status(error.statusCode).send(body(error.code, error.message, request.id));
      return;
    }

    if (error.validation) {
      this.log.warn({ err: error, requestId: request.id }, "request validation failed");
      void reply
        .status(400)
        .send(body("VALIDATION_FAILED", "Request validation failed.", request.id));
      return;
    }

    const status = error.statusCode ?? 500;
    if (status >= 500) {
      // The stack is logged, never serialized into the response.
      this.log.error({ err: error, requestId: request.id }, "unhandled error");
      void reply
        .status(500)
        .send(body("INTERNAL_ERROR", "An internal error occurred.", request.id));
      return;
    }

    // error.message is not safe to echo here: this branch handles errors that are
    // neither HarborError nor a Fastify validation error, so it can be reached by
    // dependencies (@fastify/rate-limit, @fastify/static, etc.) whose messages may
    // contain internal detail such as filesystem paths or library internals.
    // error.message is not safe to echo here: this branch handles errors that are
    // neither HarborError nor a Fastify validation error, so it can be reached by
    // dependencies (@fastify/rate-limit, @fastify/static, etc.) whose messages may
    // contain internal detail such as filesystem paths or library internals.
    this.log.warn({ err: error, requestId: request.id }, "request failed");
    let code: ErrorCode;
    let message: string;
    switch (status) {
      case 404:
        code = "NOT_FOUND";
        message = "Route not found.";
        break;
      case 429:
        code = "RATE_LIMITED";
        message = "Too many requests.";
        break;
      case 503:
        code = "SERVICE_UNAVAILABLE";
        message = "Service temporarily unavailable.";
        break;
      default:
        code = "INTERNAL_ERROR";
        message = "An internal error occurred.";
        break;
    }
    void reply.status(status).send(body(code, message, request.id));
  });
};

export const errors = fp(errorsPlugin, { name: "harbor-errors", fastify: "5.x" });

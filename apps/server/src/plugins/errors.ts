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

    this.log.warn({ err: error, requestId: request.id }, "request failed");
    void reply.status(status).send(body("INTERNAL_ERROR", error.message, request.id));
  });
};

export const errors = fp(errorsPlugin, { name: "harbor-errors", fastify: "5.x" });

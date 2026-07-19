import type { Db, Sql } from "@harbor/database";
import type { HarborEnv } from "@harbor/config";
import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import type { RuntimeState } from "../state.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    sql: Sql;
    state: RuntimeState;
    env: HarborEnv;
  }
}

export interface ContextOptions {
  db: Db;
  sql: Sql;
  state: RuntimeState;
  env: HarborEnv;
}

const contextPlugin: FastifyPluginAsync<ContextOptions> = async (fastify, opts) => {
  fastify.decorate("db", opts.db);
  fastify.decorate("sql", opts.sql);
  fastify.decorate("state", opts.state);
  fastify.decorate("env", opts.env);
};

export const context = fp(contextPlugin, { name: "harbor-context", fastify: "5.x" });

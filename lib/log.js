// ---------------------------------------------------------------------------
// Logging. Everything is one JSON line per event on stdout, which Render keeps
// in its Logs tab (and `npm run dev` pretty-prints nothing, on purpose: the
// same lines you'd grep on Render). Every request gets a request id; image
// calls are also written to the generation_log table (see db.js) so they can
// be counted per user and per model.
// ---------------------------------------------------------------------------
import pino from "pino";
import { pinoHttp } from "pino-http";
import { randomUUID } from "node:crypto";

export const log = pino({
  level: process.env.LOG_LEVEL || "info",
  base: { app: "beanstalk-book" },
  // Never log secrets, cookies or the pictures themselves.
  redact: {
    paths: ["req.headers.cookie", "req.headers.authorization", "res.headers['set-cookie']", "*.image", "*.photo"],
    remove: true,
  },
});

export const httpLog = pinoHttp({
  logger: log,
  genReqId: (req, res) => {
    const id = req.headers["x-request-id"] || randomUUID();
    res.setHeader("x-request-id", id);
    return id;
  },
  customProps: (req) => ({ user: req.user?.id ?? null }),
  // Pictures and fonts are noise; health checks every few seconds too.
  autoLogging: { ignore: (req) => /^\/(img|fonts)\/|^\/healthz$/.test(req.url) },
  customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info"),
  serializers: {
    req: (req) => ({ method: req.method, url: req.url }),
    res: (res) => ({ status: res.statusCode }),
  },
});

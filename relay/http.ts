import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { z } from "zod";
import {
  id,
  uuid,
  name,
  newCommentSchema,
  snapshotSchema,
  ProtocolError,
} from "../shared/protocol";
import { RelayStore } from "./store";
import {
  newMessageRequestSchema,
  reviewMessageRequestSchema,
} from "../shared/requests";

const LIMIT = 8 * 1024 * 1024;
async function body(req: IncomingMessage): Promise<unknown> {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json")
    throw new ProtocolError(415, "Expected application/json");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > LIMIT) throw new ProtocolError(413, "Request too large");
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ProtocolError(400, "Invalid JSON");
  }
}
function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(data));
}

export function createRelayServer(store: RelayStore) {
  // Deliberately ignore forwarded-for headers. Deploy behind a rate-limiting TLS proxy.
  const buckets = new Map<string, { until: number; count: number }>();
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.origin)
        throw new ProtocolError(
          403,
          "Browser requests are not supported; connect through the BB plugin",
        );
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = `${req.method} ${url.pathname}`;
      const now = Date.now();
      if (buckets.size > 1000)
        for (const [key, value] of buckets)
          if (value.until < now) buckets.delete(key);
      const key = `${req.socket.remoteAddress}:${route === "POST /v1/join" ? "join" : "api"}`;
      const bucket = buckets.get(key);
      if (bucket && bucket.until > now) {
        if (++bucket.count > (route === "POST /v1/join" ? 10 : 1200))
          throw new ProtocolError(429, "Rate limit exceeded; retry later");
      } else {
        if (buckets.size >= 10_000) throw new ProtocolError(503, "Server busy");
        buckets.set(key, { until: now + 60_000, count: 1 });
      }
      if (route === "GET /health")
        return send(res, 200, { ok: true, protocol: 1 });
      if (route === "POST /v1/join") {
        const input = z
          .object({ code: z.string().min(32).max(200), name })
          .strict()
          .parse(await body(req));
        return send(res, 200, store.join(input.code, input.name));
      }
      const authorization = req.headers.authorization;
      if (!authorization?.startsWith("Bearer ") || authorization.length > 220)
        throw new ProtocolError(401, "Member credential required");
      const actor = store.authenticate(authorization.slice(7));
      // Recheck after reading a mutation body: revocation may happen while it streams.
      const freshActor = () => store.authenticate(authorization.slice(7));
      const queryId = () => uuid.parse(url.searchParams.get("id"));
      const after = () =>
        z.union([id, z.literal("")]).parse(url.searchParams.get("after") ?? "");
      switch (route) {
        case "GET /v1/request-events": {
          const after = z.coerce
            .number()
            .int()
            .min(0)
            .max(Number.MAX_SAFE_INTEGER)
            .parse(url.searchParams.get("after") ?? "0");
          return send(res, 200, store.requestEvents(actor, after));
        }
        case "GET /v1/message-request":
          return send(res, 200, store.request(actor, queryId()));
        case "POST /v1/message-requests": {
          const input = newMessageRequestSchema.parse(await body(req));
          return send(res, 200, store.createRequest(freshActor(), input));
        }
        case "POST /v1/review-request": {
          const input = reviewMessageRequestSchema.parse(await body(req));
          return send(res, 200, store.reviewRequest(freshActor(), input));
        }
        case "GET /v1/me":
          return send(res, 200, store.identity(actor));
        case "POST /v1/invites":
          z.object({})
            .strict()
            .parse(await body(req));
          return send(res, 200, store.invite(freshActor()));
        case "POST /v1/revoke": {
          const input = z
            .object({ memberId: uuid })
            .strict()
            .parse(await body(req));
          store.revoke(freshActor(), input.memberId);
          return send(res, 200, { ok: true });
        }
        case "GET /v1/events": {
          const cursor = z.coerce
            .number()
            .int()
            .min(0)
            .max(Number.MAX_SAFE_INTEGER)
            .parse(url.searchParams.get("after") ?? "0");
          return send(res, 200, store.events(actor, cursor));
        }
        case "GET /v1/threads":
          return send(res, 200, { threads: store.threads(actor, after()) });
        case "GET /v1/thread":
          return send(res, 200, store.thread(actor, queryId()));
        case "POST /v1/threads": {
          const input = snapshotSchema.parse(await body(req));
          return send(res, 200, store.publish(freshActor(), input));
        }
        case "GET /v1/comments":
          return send(res, 200, {
            comments: store.comments(actor, queryId(), after()),
          });
        case "GET /v1/comment":
          return send(res, 200, store.comment(actor, queryId()));
        case "POST /v1/comments": {
          const input = newCommentSchema.parse(await body(req));
          return send(res, 200, store.addComment(freshActor(), input));
        }
        case "POST /v1/resolve": {
          const input = z
            .object({
              id: uuid,
              version: z.number().int().positive(),
              resolved: z.boolean(),
            })
            .strict()
            .parse(await body(req));
          return send(
            res,
            200,
            store.resolve(
              freshActor(),
              input.id,
              input.version,
              input.resolved,
            ),
          );
        }
        default:
          throw new ProtocolError(404, "Route not found");
      }
    } catch (error) {
      if (error instanceof ProtocolError)
        return send(res, error.status, { error: error.message });
      if (error instanceof z.ZodError)
        return send(res, 422, { error: "Invalid request" });
      // No credential, comment, or transcript payloads in errors or access logs.
      send(res, 500, { error: "Internal server error" });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 32;
  return server;
}

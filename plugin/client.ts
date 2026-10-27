import { z } from "zod";
import { ProtocolError, serverUrl } from "../shared/protocol";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const healthSchema = z.object({ ok: z.literal(true), protocol: z.literal(1) });
const routingHint =
  "Check the server URL, DNS/VPN cache and reverse proxy. This address may still resolve to a different server.";
const httpErrors: Record<number, string> = {
  401: "Credential is invalid or revoked. Reconnect with a new credential.",
  403: "Permission denied or invitation invalid/expired.",
  404: "Relay endpoint not found. Check the server URL and reverse proxy.",
  409: "Conflict: reload the latest state and try again.",
  413: "Request is too large for the relay or reverse proxy.",
  422: "Relay rejected the request.",
  429: "Relay rate limit reached. Try again later.",
  502: `The reverse proxy returned HTTP 502 (Bad Gateway). ${routingHint}`,
  503: "Relay is temporarily unavailable (HTTP 503). Try again later.",
  504: "The reverse proxy timed out waiting for the relay (HTTP 504).",
};

export class RelayClient {
  readonly origin: string;
  constructor(
    origin: string,
    private token: string,
    private signal?: AbortSignal,
  ) {
    this.origin = serverUrl(origin);
  }

  /** An unauthenticated preflight, not proof of server identity (TLS still is).
   * Never send a member credential or invitation to a visibly wrong endpoint.
   */
  async checkHealth(): Promise<void> {
    await this.request("/health", healthSchema, undefined, false);
  }

  async call<T>(
    path: string,
    schema: z.ZodType<T>,
    input?: unknown,
  ): Promise<T> {
    return this.request(`/v1/${path}`, schema, input, true);
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    input: unknown,
    authenticated: boolean,
  ): Promise<T> {
    const timeout = AbortSignal.timeout(10_000);
    const signal = this.signal
      ? AbortSignal.any([this.signal, timeout])
      : timeout;
    let response: Response;
    try {
      response = await fetch(`${this.origin}${path}`, {
        method: input === undefined ? "GET" : "POST",
        headers: {
          accept: "application/json",
          ...(authenticated && this.token
            ? { authorization: `Bearer ${this.token}` }
            : {}),
          ...(input === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        body: input === undefined ? undefined : JSON.stringify(input),
        redirect: "error",
        signal,
      });
    } catch {
      if (this.signal?.aborted) throw new Error("Relay request cancelled.");
      if (timeout.aborted)
        throw new Error(
          "Relay request timed out. Check the server and network connection.",
        );
      throw new Error(
        "Could not reach the relay. Check DNS/VPN, TLS and the server URL. Redirects are not followed.",
      );
    }

    // Use only known MIME labels, never reflect server-supplied headers/body in errors.
    const mediaType = response.headers
      .get("content-type")
      ?.split(";")[0]
      .trim()
      .toLowerCase();
    if (mediaType !== "application/json") {
      await response.body?.cancel();
      const kind = mediaType === "text/html" ? "HTML" : "non-JSON content";
      // Do not classify a different site's 401 page as revoked membership: that
      // would incorrectly clear the saved connection and outbound state.
      throw new Error(
        `Server returned HTTP ${response.status} (${kind}), not Multiplayer relay JSON. ` +
          (response.status === 429
            ? "Rate limit reached; try again later. "
            : "") +
          routingHint,
      );
    }
    if (
      Number(response.headers.get("content-length") ?? 0) > MAX_RESPONSE_BYTES
    ) {
      await response.body?.cancel();
      throw new Error("Relay response too large");
    }
    const reader = response.body?.getReader();
    if (!reader)
      throw new Error(
        `Relay returned an empty response (HTTP ${response.status}). ${routingHint}`,
      );
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error("Relay response too large");
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    let data: unknown;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new Error(
        `Server returned invalid JSON (HTTP ${response.status}). ${routingHint}`,
      );
    }
    if (!response.ok) {
      // Status alone does not prove this is a relay failure. Require its JSON
      // error envelope; never echo its message, which could contain secrets.
      const message =
        httpErrors[response.status] ??
        `Relay request failed (HTTP ${response.status}).`;
      if (!z.object({ error: z.string() }).safeParse(data).success) {
        throw new Error(
          `Unexpected server response (HTTP ${response.status}). ${routingHint}`,
        );
      }
      throw new ProtocolError(response.status, message);
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new Error(
        "Server JSON does not match the expected Multiplayer relay protocol. Check the server URL and client/server versions.",
      );
    }
    return parsed.data;
  }
}

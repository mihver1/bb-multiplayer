import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RelayClient } from "../plugin/client";
import { ProtocolError } from "../shared/protocol";

const valueSchema = z.object({ value: z.string() });
const secret = "private-credential-must-not-appear-in-errors";
const client = () => new RelayClient("https://relay.example", secret);
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
afterEach(() => vi.unstubAllGlobals());

describe("relay response diagnostics and credential safety", () => {
  it.each([200, 401, 502, 504])(
    "explains an HTML HTTP %i response without reflecting its body or treating it as revocation",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(`<html>${secret}</html>`, {
            status,
            headers: { "content-type": "text/html" },
          }),
        ),
      );
      const error = await client()
        .call("me", valueSchema)
        .catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ProtocolError);
      expect((error as Error).message).toContain(`HTTP ${status} (HTML)`);
      expect((error as Error).message).toContain("DNS/VPN");
      expect((error as Error).message).not.toContain(secret);
    },
  );
  it.each([401, 403, 429, 502])(
    "preserves a relay JSON HTTP %i error without reflecting its message",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(json({ error: secret }, status)),
      );
      const error = await client()
        .call("me", valueSchema)
        .catch((e: Error) => e);
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).status).toBe(status);
      expect((error as Error).message).not.toContain(secret);
    },
  );
  it("does not clear credentials for an unrelated JSON 401 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ login: true }, 401)),
    );
    await expect(client().call("me", valueSchema)).rejects.toThrow(
      "Unexpected server response (HTTP 401)",
    );
  });
  it("reports malformed JSON without including its contents", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(`{"${secret}`, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await expect(client().call("me", valueSchema)).rejects.toThrow(
      "invalid JSON (HTTP 200)",
    );
  });
  it("reports schema mismatch without including attacker-controlled keys or values", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ [secret]: secret, value: 42 })),
    );
    const error = await client()
      .call("me", valueSchema)
      .catch((e: Error) => e);
    expect((error as Error).message).toContain(
      "expected Multiplayer relay protocol",
    );
    expect((error as Error).message).not.toContain(secret);
  });
  it("does not leak a raw network error and never follows redirects", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValue(new Error(`network error: ${secret}`));
    vi.stubGlobal("fetch", fetch);
    await expect(client().call("me", valueSchema)).rejects.toThrow(
      "Check DNS/VPN, TLS",
    );
    expect(fetch.mock.calls[0][1].redirect).toBe("error");
  });
  it("bounds streaming responses without trusting Content-Length", async () => {
    const cancelled = vi.fn();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
      },
      cancel: cancelled,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(stream, {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await expect(client().call("me", valueSchema)).rejects.toThrow("too large");
    expect(cancelled).toHaveBeenCalledOnce();
  });
  it("checks health without Authorization, cookies or a body, even if the client has a credential", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ ok: true, protocol: 1 }));
    vi.stubGlobal("fetch", fetch);
    await client().checkHealth();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://relay.example/health");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ accept: "application/json" });
  });
  it("rejects an unsupported health protocol before authentication", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ ok: true, protocol: 2 })),
    );
    await expect(client().checkHealth()).rejects.toThrow(
      "expected Multiplayer relay protocol",
    );
  });
  it("accepts valid JSON responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ value: "ok" })));
    expect(await client().call("me", valueSchema)).toEqual({ value: "ok" });
  });
});

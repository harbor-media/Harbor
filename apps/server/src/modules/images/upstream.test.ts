import { describe, expect, it, vi } from "vitest";
import { fetchUpstreamImage, ImageFetchError } from "./upstream.js";

function response(body: string, init: { status?: number; type?: string } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: init.type === undefined ? {} : { "content-type": init.type },
  });
}

function fake(impl: () => Promise<Response>): typeof fetch {
  return vi.fn(impl) as unknown as typeof fetch;
}

async function drain(body: AsyncIterable<Uint8Array>): Promise<number> {
  let total = 0;
  for await (const chunk of body) total += chunk.byteLength;
  return total;
}

const SIGNAL = (): AbortSignal => AbortSignal.timeout(5000);

describe("fetchUpstreamImage", () => {
  it("returns the body for an allowed content type", async () => {
    const result = await fetchUpstreamImage("https://cdn.example/a.jpg", {
      fetchImpl: fake(async () => response("imagebytes", { type: "image/jpeg" })),
      signal: SIGNAL(),
    });

    expect(result.contentType).toBe("image/jpeg");
    expect(await drain(result.body)).toBe(10);
  });

  it("accepts png and webp", async () => {
    for (const type of ["image/png", "image/webp"]) {
      const result = await fetchUpstreamImage("https://cdn.example/a", {
        fetchImpl: fake(async () => response("x", { type })),
        signal: SIGNAL(),
      });
      expect(result.contentType).toBe(type);
    }
  });

  it("tolerates parameters and casing on the content type", async () => {
    const result = await fetchUpstreamImage("https://cdn.example/a.jpg", {
      fetchImpl: fake(async () => response("x", { type: "IMAGE/JPEG; charset=binary" })),
      signal: SIGNAL(),
    });
    expect(result.contentType).toBe("image/jpeg");
  });

  // The single most important test in this file. An SVG served from Harbor's
  // own origin is an active document with access to the session cookie --
  // stored XSS delivered through what looks like a static file cache.
  it("refuses image/svg+xml", async () => {
    await expect(
      fetchUpstreamImage("https://cdn.example/a.jpg", {
        fetchImpl: fake(async () => response("<svg onload='steal()'/>", { type: "image/svg+xml" })),
        signal: SIGNAL(),
      }),
    ).rejects.toMatchObject({ kind: "rejected-type" });
  });

  it("refuses text/html", async () => {
    await expect(
      fetchUpstreamImage("https://cdn.example/a.jpg", {
        fetchImpl: fake(async () => response("<html/>", { type: "text/html" })),
        signal: SIGNAL(),
      }),
    ).rejects.toMatchObject({ kind: "rejected-type" });
  });

  it("refuses a missing content type", async () => {
    await expect(
      fetchUpstreamImage("https://cdn.example/a.jpg", {
        fetchImpl: fake(async () => response("x")),
        signal: SIGNAL(),
      }),
    ).rejects.toMatchObject({ kind: "rejected-type" });
  });

  it("maps 404 to not-found", async () => {
    await expect(
      fetchUpstreamImage("https://cdn.example/a.jpg", {
        fetchImpl: fake(async () => response("", { status: 404, type: "text/plain" })),
        signal: SIGNAL(),
      }),
    ).rejects.toMatchObject({ kind: "not-found" });
  });

  it("maps other error statuses to unavailable", async () => {
    await expect(
      fetchUpstreamImage("https://cdn.example/a.jpg", {
        fetchImpl: fake(async () => response("", { status: 500, type: "text/plain" })),
        signal: SIGNAL(),
      }),
    ).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("maps a network failure to unavailable", async () => {
    await expect(
      fetchUpstreamImage("https://cdn.example/a.jpg", {
        fetchImpl: fake(async () => {
          throw new Error("ECONNREFUSED");
        }),
        signal: SIGNAL(),
      }),
    ).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("keeps upstream error text out of the thrown message", async () => {
    await expect(
      fetchUpstreamImage("https://cdn.example/a.jpg", {
        fetchImpl: fake(async () => {
          throw new Error("connect failed to 10.0.0.5 with authorization Bearer sekret");
        }),
        signal: SIGNAL(),
      }),
    ).rejects.toSatisfy((error: Error) => !error.message.includes("sekret"));
  });

  // Refusing redirects removes the "revalidate every redirect destination"
  // requirement entirely rather than implementing it, and closes the one path
  // by which this design could be steered to an attacker-chosen host.
  it("passes redirect: error so redirects are never followed", async () => {
    const fetchImpl = vi.fn(async () => response("x", { type: "image/jpeg" }));
    await fetchUpstreamImage("https://cdn.example/a.jpg", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      signal: SIGNAL(),
    });
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
  });

  it("aborts a body that exceeds the byte cap while streaming", async () => {
    const result = await fetchUpstreamImage("https://cdn.example/a.jpg", {
      fetchImpl: fake(async () => response("0123456789", { type: "image/jpeg" })),
      signal: SIGNAL(),
      maxBytes: 4,
    });

    await expect(drain(result.body)).rejects.toMatchObject({ kind: "too-large" });
  });

  it("rejects up front when content-length already exceeds the cap", async () => {
    await expect(
      fetchUpstreamImage("https://cdn.example/a.jpg", {
        fetchImpl: fake(
          async () =>
            new Response("x", {
              status: 200,
              headers: { "content-type": "image/jpeg", "content-length": "99999999" },
            }),
        ),
        signal: SIGNAL(),
        maxBytes: 1024,
      }),
    ).rejects.toMatchObject({ kind: "too-large" });
  });

  it("still serves a body whose declared length is within the cap", async () => {
    const result = await fetchUpstreamImage("https://cdn.example/a.jpg", {
      fetchImpl: fake(
        async () =>
          new Response("12345", {
            status: 200,
            headers: { "content-type": "image/jpeg", "content-length": "5" },
          }),
      ),
      signal: SIGNAL(),
      maxBytes: 1024,
    });

    expect(await drain(result.body)).toBe(5);
  });

  it("throws ImageFetchError instances", async () => {
    await expect(
      fetchUpstreamImage("https://cdn.example/a.jpg", {
        fetchImpl: fake(async () => response("x", { type: "image/svg+xml" })),
        signal: SIGNAL(),
      }),
    ).rejects.toBeInstanceOf(ImageFetchError);
  });
});

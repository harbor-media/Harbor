export type ImageFailureKind = "not-found" | "unavailable" | "rejected-type" | "too-large";

export class ImageFetchError extends Error {
  constructor(
    readonly kind: ImageFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "ImageFetchError";
  }
}

/**
 * Raster formats only.
 *
 * image/svg+xml is excluded deliberately and must stay excluded: an SVG is an
 * active document that may contain <script>, and served from Harbor's own
 * origin it would run as first-party JavaScript with access to the session
 * cookie. That turns a static file cache into stored XSS.
 */
export const ALLOWED_CONTENT_TYPES: readonly string[] = ["image/jpeg", "image/png", "image/webp"];

export const MAX_IMAGE_BYTES = 10_485_760;

export interface FetchedImage {
  contentType: string;
  body: AsyncIterable<Uint8Array>;
}

/**
 * Enforces the cap while streaming, so an upstream that lies about (or omits)
 * content-length still cannot exhaust disk or memory. Checking the declared
 * length alone would trust the very party we are guarding against.
 */
async function* capped(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): AsyncIterable<Uint8Array> {
  let seen = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value === undefined) continue;
      seen += value.byteLength;
      if (seen > maxBytes) {
        throw new ImageFetchError("too-large", "Upstream image exceeded the size limit.");
      }
      yield value;
    }
  } finally {
    reader.releaseLock();
    await body.cancel().catch(() => undefined);
  }
}

export async function fetchUpstreamImage(
  url: string,
  options: { fetchImpl?: typeof fetch; signal: AbortSignal; maxBytes?: number },
): Promise<FetchedImage> {
  const doFetch = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES;

  let response: Response;
  try {
    response = await doFetch(url, {
      // Never follow redirects. CLAUDE.md requires revalidating every redirect
      // destination; refusing them outright removes that requirement instead
      // of implementing it, and provider CDNs serve images directly. A
      // followed redirect is also the one way this design could be steered to
      // an attacker-chosen host despite taking no hostname as input.
      redirect: "error",
      signal: options.signal,
      headers: { accept: ALLOWED_CONTENT_TYPES.join(", ") },
    });
  } catch {
    // The underlying error is swallowed rather than chained: it can carry the
    // request URL and headers into logs and error bodies.
    throw new ImageFetchError("unavailable", "The image provider could not be reached.");
  }

  if (response.status === 404) {
    throw new ImageFetchError("not-found", "The image does not exist upstream.");
  }
  if (!response.ok) {
    throw new ImageFetchError("unavailable", "The image provider returned an error.");
  }

  const rawType = response.headers.get("content-type") ?? "";
  const contentType = rawType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
    throw new ImageFetchError("rejected-type", "Upstream returned a disallowed content type.");
  }

  const declaredHeader = response.headers.get("content-length");
  if (declaredHeader !== null) {
    const declared = Number(declaredHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new ImageFetchError("too-large", "Upstream image exceeded the size limit.");
    }
  }

  if (!response.body) {
    throw new ImageFetchError("unavailable", "Upstream returned no body.");
  }

  return { contentType, body: capped(response.body, maxBytes) };
}

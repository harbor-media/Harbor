import { IMAGE_PROVIDERS, isImageProviderId, type ImageProviderId } from "./providers.js";

/**
 * A single path segment: letters, digits, dot, underscore, hyphen, then one
 * raster image extension.
 *
 * The exclusion of "/" and "\" is what makes directory traversal
 * unrepresentable rather than filtered -- a name that cannot contain a
 * separator cannot describe another directory, so there is no encoding or
 * normalization trick to find. Fastify URL-decodes route parameters before
 * they reach here, so an encoded "%2f" arrives as a literal "/" and is
 * rejected by this pattern rather than slipping through as text.
 *
 * The extension allowlist deliberately excludes .svg. An SVG is an active
 * document and may contain <script>; served from Harbor's own origin it
 * would run as first-party JavaScript with access to the session cookie.
 */
const FILE_PATTERN = /^[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$/;

export interface ImageRequest {
  provider: ImageProviderId;
  size: string;
  file: string;
}

export class InvalidImageRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidImageRequestError";
  }
}

export function parseImageRequest(provider: string, size: string, file: string): ImageRequest {
  if (!isImageProviderId(provider)) {
    throw new InvalidImageRequestError("Unknown image provider.");
  }

  const definition = IMAGE_PROVIDERS[provider];
  if (!(definition.sizes as readonly string[]).includes(size)) {
    throw new InvalidImageRequestError("Unsupported image size.");
  }

  if (!FILE_PATTERN.test(file)) {
    throw new InvalidImageRequestError("Malformed image filename.");
  }

  return { provider, size, file };
}

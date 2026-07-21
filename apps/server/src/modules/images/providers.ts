/**
 * The only hosts Harbor will fetch images from. A request names a provider
 * key, never a URL, so there is no input through which a caller can reach an
 * arbitrary host -- loopback, link-local, cloud metadata, or otherwise.
 * Classic image-proxy SSRF is not filtered here; it is unrepresentable.
 */
export const IMAGE_PROVIDERS = {
  tmdb: {
    defaultBaseUrl: "https://image.tmdb.org/t/p",
    // TMDB publishes these pre-rendered widths. Harbor passes them through
    // rather than resizing, which is why it needs no native image library
    // and no arm64 build story for one.
    sizes: ["w92", "w154", "w185", "w342", "w500", "w780", "original"],
  },
} as const;

export type ImageProviderId = keyof typeof IMAGE_PROVIDERS;

export function isImageProviderId(value: string): value is ImageProviderId {
  return Object.prototype.hasOwnProperty.call(IMAGE_PROVIDERS, value);
}

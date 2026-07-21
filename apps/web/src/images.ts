/**
 * Builds a Harbor image URL from the provider-relative path stored with a
 * title.
 *
 * The browser never sees the provider's own hostname. Harbor's CSP
 * (`img-src 'self'`) would block it anyway, and proxying keeps each user's
 * browsing activity from leaking to the provider one poster at a time.
 */
export function imageUrl(posterPath: string | null, size = "w342"): string | null {
  if (posterPath === null || posterPath === "") return null;

  // Stored paths are provider-relative and begin with a slash.
  const file = posterPath.replace(/^\/+/, "");

  // Anything with a remaining separator is not a bare filename, so it is not
  // something this route can serve. Returning null renders the placeholder
  // rather than sending a request the server would reject anyway.
  if (file === "" || file.includes("/") || file.includes("\\")) return null;

  return `/api/v1/images/tmdb/${size}/${encodeURIComponent(file)}`;
}

import { createServer } from "node:http";

// Stands in for the TMDB image CDN so the end-to-end suite never touches the
// real service. Depending on it here would make the suite fail on a third
// party's outage, need a real credential in CI, and put load on someone
// else's servers on every run.
//
// Deliberately minimal: it answers only what Harbor asks for in this phase.

const PORT = Number(process.env["IMAGE_FIXTURE_PORT"] ?? 3102);

// A real 1x1 PNG. Harbor declares it image/jpeg because what matters to the
// tests is the declared content type, not the bytes -- but it must be a
// genuine image so the browser reports naturalWidth > 0 and the spec can tell
// a rendered poster from a broken one.
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** Counts upstream hits so a spec can prove Harbor served from its own cache
 *  rather than re-fetching. Without this the "cached" assertion would only be
 *  checking that bytes came back, which passes either way. */
let served = 0;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${String(PORT)}`);

  if (url.pathname === "/count") {
    const body = JSON.stringify({ served });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
    return;
  }

  if (url.pathname === "/reset") {
    served = 0;
    res.writeHead(204);
    res.end();
    return;
  }

  // A path Harbor should treat as genuinely absent upstream.
  if (url.pathname.includes("missing")) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }

  // Hostile content: an SVG would execute as first-party script if Harbor
  // ever served it from its own origin. Harbor must refuse it.
  if (url.pathname.includes("evil")) {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    res.writeHead(200, { "content-type": "image/svg+xml" });
    res.end(svg);
    return;
  }

  served += 1;
  res.writeHead(200, { "content-type": "image/jpeg", "content-length": PIXEL.length });
  res.end(PIXEL);
});

server.listen(PORT, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(`image fixture listening on http://127.0.0.1:${String(PORT)}`);
});

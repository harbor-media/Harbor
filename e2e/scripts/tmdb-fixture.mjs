import { createServer } from "node:http";

// A stand-in for the TMDB API, so the end-to-end suite never touches the real
// service. Depending on TMDB here would make the suite fail on a third
// party's outage, need a real credential in CI, and put load on someone
// else's servers on every run.
//
// It is deliberately minimal: it answers only the two endpoints Harbor calls
// in this phase, and it is NOT a general TMDB emulator.

const PORT = Number(process.env["TMDB_FIXTURE_PORT"] ?? 3101);

// Matches the key the e2e spec enters in the admin form. Anything else is
// rejected with a 401, which is what exercises Harbor's "TMDB rejected this
// key" path with a real HTTP status rather than a mocked function.
const VALID_KEY = "e2e-valid-tmdb-token";

const SEARCH_RESULTS = {
  results: [
    {
      id: 78,
      media_type: "movie",
      title: "Blade Runner",
      original_title: "Blade Runner",
      release_date: "1982-06-25",
      overview: "A blade runner must pursue replicants.",
      poster_path: "/poster.jpg",
      backdrop_path: "/backdrop.jpg",
    },
    {
      id: 335984,
      media_type: "movie",
      title: "Blade Runner 2049",
      original_title: "Blade Runner 2049",
      release_date: "2017-10-04",
      overview: "A young blade runner uncovers a secret.",
      poster_path: "/2049.jpg",
      backdrop_path: null,
    },
    // A person result, included on purpose: Harbor must drop it rather than
    // list an actor as a watchable title.
    { id: 999, media_type: "person", name: "Ridley Scott" },
  ],
};

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${String(PORT)}`);

  // Harbor must send the credential as a bearer token, never in the query
  // string. Reading it from the header here means a regression that moved it
  // into the URL would fail the suite rather than pass silently.
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${VALID_KEY}`) {
    send(res, 401, { status_message: "Invalid API key" });
    return;
  }

  if (url.pathname === "/authentication") {
    send(res, 200, { success: true });
    return;
  }

  if (url.pathname === "/search/multi") {
    send(res, 200, SEARCH_RESULTS);
    return;
  }

  send(res, 404, { status_message: "Not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(`tmdb fixture listening on http://127.0.0.1:${String(PORT)}`);
});

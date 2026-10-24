import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const appRoot = resolve(here, "..");
const publicRoot = join(appRoot, "public");
const distRoot = join(appRoot, "dist");
const production = process.argv.includes("--production");
const root = production && (await exists(distRoot)) ? distRoot : publicRoot;
const host = process.env.WEB_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.WEB_PORT || 5173);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("WEB_PORT must be an integer between 1 and 65535.");
}

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
]);

const server = createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end("Method not allowed");
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url || "/", "http://localhost").pathname);
  } catch {
    response.writeHead(400);
    response.end("Invalid URL");
    return;
  }

  const relativePath = normalize(pathname.replace(/^[/\\]+/, ""));
  let candidate = resolve(root, relativePath || "index.html");
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const metadata = await stat(candidate);
    if (metadata.isDirectory()) candidate = join(candidate, "index.html");
    await access(candidate);
  } catch {
    // The app is a small single-page workbench. Unknown non-asset routes fall
    // back to the shell; missing scripts/styles remain proper 404s.
    const extension = extname(candidate);
    if (extension) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    candidate = join(root, "index.html");
  }

  const headers = {
    "content-type": contentTypes.get(extname(candidate)) || "application/octet-stream",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "cache-control": extname(candidate) === ".html" ? "no-cache" : "public, max-age=300",
  };
  if (request.method === "HEAD") {
    response.writeHead(200, headers);
    response.end();
    return;
  }
  try {
    const metadata = await stat(candidate);
    headers["content-length"] = metadata.size;
    response.writeHead(200, headers);
    createReadStream(candidate).pipe(response);
  } catch {
    response.writeHead(500);
    response.end("Could not serve this file");
  }
});

server.listen(port, host, () => {
  process.stdout.write(
    JSON.stringify({
      service: "kurochan-web",
      host,
      port,
      root,
      mode: production ? "production" : "development",
    }) + "\n",
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

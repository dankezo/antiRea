/**
 * Canary Maze benchmark harness server (NOT part of the antiRea package).
 *
 * Serves a tiny realistic site on top of the built antiRea package:
 *   /              homepage with one real link (/about) + the bait trap link
 *   /about         a real page
 *   /api/v1/status a real API-like JSON route
 *   /robots.txt    User-agent line + the canaryRobotsTxt() Disallow line
 *   /_canary/...   the Canary Maze (createCanaryMaze, enabled, cap 30/IP)
 *   /__stats       harness-only counters { mazeServed, alerts, mazeRequests }
 * Everything else returns a plain 404.
 *
 * Run: PORT=8931 REQLOG=./requests.log node server.cjs
 * The package is resolved from $ANTI_REA_PKG, else ../../ (when this file
 * lives in <repo>/benchmark/canary-maze/), else the known local repo path.
 */
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");

function resolvePackage() {
  const candidates = [
    process.env.ANTI_REA_PKG,
    path.join(__dirname, "..", ".."),
    "/home/hatch/workspace/antirea-220",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(candidate, "package.json"), "utf8"));
      if (pkg.name === "@dannyphan190/anti-rea") return candidate;
    } catch {
      /* try next */
    }
  }
  throw new Error("could not locate the @dannyphan190/anti-rea package");
}

const { createCanaryMaze, canaryTrapLink, canaryRobotsTxt } = require(resolvePackage());

const PORT = Number(process.env.PORT || 8931);
const REQLOG = process.env.REQLOG || path.join(__dirname, "requests.log");

let mazeServed = 0;
let alerts = 0;
let mazeRequests = 0;

const maze = createCanaryMaze({
  enabled: true,
  prefix: "/_canary/",
  maxRequestsPerIp: 30,
  windowMs: 600000,
  linksPerPage: 8,
  onAlert: () => {
    alerts += 1;
  },
});

const homepage = [
  "<!doctype html>",
  '<html lang="en">',
  "<head>",
  '<meta charset="utf-8">',
  "<title>Benchmark Test Site</title>",
  "</head>",
  "<body>",
  "<h1>Benchmark Test Site</h1>",
  "<p>A small test site used to measure Canary Maze behaviour. It has one real page and one real API route.</p>",
  '<p><a href="/about">About this site</a></p>',
  canaryTrapLink("/_canary/"),
  "</body>",
  "</html>",
].join("\n");

const aboutPage = [
  "<!doctype html>",
  '<html lang="en">',
  "<head>",
  '<meta charset="utf-8">',
  "<title>About - Benchmark Test Site</title>",
  "</head>",
  "<body>",
  "<h1>About</h1>",
  "<p>This is a real page on the benchmark test site.</p>",
  '<p><a href="/">Home</a></p>',
  "</body>",
  "</html>",
].join("\n");

const robotsTxt = "User-agent: *\n" + canaryRobotsTxt("/_canary/");

function logLine(line) {
  try {
    fs.appendFileSync(REQLOG, line + "\n");
  } catch {
    /* logging must never break the harness */
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const pathname = url.pathname;
  let status = 404;

  const send = (code, body, contentType) => {
    status = code;
    res.writeHead(code, { "content-type": contentType });
    res.end(body);
  };

  try {
    if (pathname === "/__stats") {
      send(200, JSON.stringify({ mazeServed, alerts, mazeRequests }), "application/json");
    } else if (pathname === "/") {
      send(200, homepage, "text/html; charset=utf-8");
    } else if (pathname === "/about") {
      send(200, aboutPage, "text/html; charset=utf-8");
    } else if (pathname === "/api/v1/status") {
      send(200, JSON.stringify({ status: "ok" }), "application/json");
    } else if (pathname === "/robots.txt") {
      send(200, robotsTxt, "text/plain; charset=utf-8");
    } else if (pathname === "/_canary" || pathname.startsWith("/_canary/")) {
      mazeRequests += 1;
      const result = await maze.handle({
        url: req.url || pathname,
        method: req.method,
        headers: { get: (name) => req.headers[String(name).toLowerCase()] ?? null },
        remoteAddress: req.socket.remoteAddress,
      });
      if (result.html && result.status === 200) {
        mazeServed += 1;
        send(200, result.html, result.contentType || "text/html; charset=utf-8");
      } else if (result.isTrapped) {
        send(result.status, JSON.stringify(result.body), "application/json");
      } else {
        send(404, "not found", "text/plain; charset=utf-8");
      }
    } else {
      send(404, "not found", "text/plain; charset=utf-8");
    }
  } catch (err) {
    status = 500;
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("harness error: " + (err && err.message));
  }
  logLine(`${req.method} ${req.url} -> ${status}`);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`maze bench server listening on http://127.0.0.1:${PORT}`);
});

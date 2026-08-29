import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const files = new Map([
  ["/", [path.join(repo, "kiem-thu", "p7-browser-harness.html"), "text/html; charset=utf-8"]],
  ["/public/config.js", [path.join(repo, "public", "config.js"), "text/javascript; charset=utf-8"]],
  ["/public/training.js", [path.join(repo, "public", "training.js"), "text/javascript; charset=utf-8"]],
  ["/public/chat-media.js", [path.join(repo, "public", "chat-media.js"), "text/javascript; charset=utf-8"]],
  ["/public/style.css", [path.join(repo, "public", "style.css"), "text/css; charset=utf-8"]],
]);

const server = http.createServer((req, res) => {
  const entry = files.get(new URL(req.url, "http://127.0.0.1").pathname);
  if (!entry) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": entry[1], "Cache-Control": "no-store" });
  fs.createReadStream(entry[0]).pipe(res);
});

server.listen(3792, "127.0.0.1", () => {
  console.log("P7_BROWSER_HARNESS=http://127.0.0.1:3792/");
});

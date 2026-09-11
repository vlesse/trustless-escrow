// 开发用静态服务器。生产环境请用任意静态托管（GitHub Pages / Cloudflare Pages / IPFS）。
const http = require("http"), fs = require("fs"), path = require("path");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                ".css": "text/css; charset=utf-8", ".txt": "text/plain; charset=utf-8" };
http.createServer((req, res) => {
  const url = req.url.split("?")[0].split("#")[0];
  const file = path.join(__dirname, url === "/" ? "index.html" : url);
  if (!file.startsWith(__dirname)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, {"Content-Type":"text/plain"}).end("not found"); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(buf);
  });
}).listen(8788, () => console.log("签名页开发服务器: http://127.0.0.1:8788"));

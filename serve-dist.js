import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = Number(process.env.PORT) || 3000;
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.wasm': 'application/wasm',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.json': 'application/json',
};

function serve(port) {
  http.createServer((req, res) => {
    const url = req.url === '/' ? '/index.html' : decodeURIComponent(req.url);
    const file = path.join(DIST, url);

    if (!file.startsWith(DIST)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    if (!fs.existsSync(file)) {
      res.writeHead(404).end('Not found');
      return;
    }

    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }).listen(port, () => {
    console.log(`\n  游戏服务器已启动 → http://localhost:${port}\n`);
  }).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`  端口 ${port} 被占用，尝试 ${port + 1} ...`);
      serve(port + 1);
    } else {
      throw err;
    }
  });
}

serve(BASE);

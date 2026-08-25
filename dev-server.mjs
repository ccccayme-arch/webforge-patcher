// WebForge Patcher — Local Development Server
// WebUSB requires HTTPS (or localhost). This config serves the PWA locally.

// Quick start:
//   cd webforge-patcher
//   npx serve . -l 3000

// Or with Python:
//   python3 -m http.server 3000

// Or with this script:
//   node dev-server.mjs

// Then open http://localhost:3000 in Chrome.
// WebUSB works on localhost without HTTPS.

import { createServer } from 'http';
import { readFile, stat } from 'fs/promises';
import { extname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT || 3000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const server = createServer(async (req, res) => {
  try {
    let urlPath = req.url.split('?')[0];
    if (urlPath === '/') urlPath = '/index.html';

    const filePath = join(__dirname, urlPath);
    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // Security: prevent directory traversal
    if (!filePath.startsWith(__dirname)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // SPA fallback
      try {
        const data = await readFile(join(__dirname, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
    } else {
      res.writeHead(500);
      res.end(`Server error: ${err.message}`);
    }
  }
});

server.listen(PORT, () => {
  console.log(`\n  WebForge Patcher dev server\n`);
  console.log(`  → http://localhost:${PORT}\n`);
  console.log(`  WebUSB works on localhost without HTTPS.`);
  console.log(`  Press Ctrl+C to stop.\n`);
});

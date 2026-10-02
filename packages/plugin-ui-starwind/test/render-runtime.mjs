import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';

export async function serveRenderedSite(project) {
  const server = createServer((request, response) => {
    const requestPath = new URL(request.url, 'http://localhost').pathname;
    const file = requestPath === '/' ? 'index.html' : requestPath.slice(1);
    if (!/^(index\.html|fixture\.svg|_astro\/[\w.-]+\.css)$/.test(file)) { response.writeHead(404).end(); return; }
    try {
      response.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html');
      response.end(readFileSync(path.join(project, 'dist', file)));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server;
}

export function browserOptions() {
  const executablePath = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((file) => file && existsSync(file));
  if (!executablePath) throw new Error('Install Chrome or set CHROME_PATH for the composition browser checks.');
  return { executablePath, headless: true };
}

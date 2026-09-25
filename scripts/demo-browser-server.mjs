import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const page = fileURLToPath(new URL('../demo/browser/index.html', import.meta.url));
const port = 4173;
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  createReadStream(page).pipe(response);
});
server.listen(port, '127.0.0.1', () => process.stdout.write(`Jev browser demo: http://127.0.0.1:${port}\nPress Ctrl+C to stop.\n`));

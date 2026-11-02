import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { browserCommand, serviceState, siteUrl, start } from '../scripts/start-web.mjs';

assert.equal(siteUrl('4321'), 'http://127.0.0.1:4321/');
for (const port of ['0', '65536', 'bad', '3210 & calc']) assert.throws(() => siteUrl(port));
const url = siteUrl('4321');
assert.equal(browserCommand(url, 'win32')[0], 'powershell.exe');
assert.deepEqual(browserCommand(url, 'darwin'), ['open', [url]]);
assert.deepEqual(browserCommand(url, 'linux'), ['xdg-open', [url]]);
const server = http.createServer((_req, res) => res.end('{"another":"app"}'));
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const port = server.address().port;
const oldPort = process.env.FOLIO_WEB_PORT, oldData = process.env.FOLIO_WEB_DATA;
let child;
try {
  process.env.FOLIO_WEB_PORT = String(port);
  assert.equal(await serviceState(siteUrl()), 'occupied');
  await assert.rejects(start({ openBrowser: () => assert.fail('must not open another application') }), /占用/);
  await new Promise(resolve => server.close(resolve));
  server.closeAllConnections();
  process.env.FOLIO_WEB_DATA = path.resolve('tests/tmp/launcher');
  await fs.mkdir(process.env.FOLIO_WEB_DATA, { recursive: true });
  const opened = [];
  child = await start({ openBrowser: async url => { assert.equal(await serviceState(url), 'ready'); opened.push(url); } });
  assert(child, 'starts an actual isolated server');
  assert.equal(await start({ openBrowser: async url => opened.push(url) }), null, 'second launch reuses server');
  assert.deepEqual(opened, [siteUrl(), siteUrl()]);
  console.log('launcher: actual isolated startup, readiness, repeat launch, occupied port and browser commands passed');
} finally {
  if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
  server.close(); server.closeAllConnections();
  if (oldPort === undefined) delete process.env.FOLIO_WEB_PORT; else process.env.FOLIO_WEB_PORT = oldPort;
  if (oldData === undefined) delete process.env.FOLIO_WEB_DATA; else process.env.FOLIO_WEB_DATA = oldData;
}

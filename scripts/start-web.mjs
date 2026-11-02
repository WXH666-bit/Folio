import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function siteUrl(port = process.env.FOLIO_WEB_PORT ?? '3210') {
  if (!/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) {
    throw Error('FOLIO_WEB_PORT 必须是 1 到 65535 的端口号。');
  }
  return `http://127.0.0.1:${Number(port)}/`;
}

export async function serviceState(url) {
  let response;
  try { response = await fetch(new URL('api/status', url), { signal: AbortSignal.timeout(1500) }); }
  catch { return 'unavailable'; }
  try {
    const status = await response.json();
    return response.ok && typeof status.pi?.installed === 'boolean' &&
      typeof status.model?.hasKey === 'boolean' && Array.isArray(status.supported) &&
      status.supported.includes('pdf') ? 'ready' : 'occupied';
  } catch { return 'occupied'; }
}

export function browserCommand(url, platform = process.platform) {
  if (platform === 'win32') return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process '${url}'`]];
  return platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
}

async function openInBrowser(url) {
  const [command, args] = browserCommand(url);
  await new Promise((resolve, reject) => {
    const browser = spawn(command, args, { windowsHide: true, stdio: 'ignore' });
    browser.once('error', reject);
    browser.once('exit', code => code === 0 ? resolve() : reject(Error('浏览器未能自动打开')));
  });
}

export async function start({ openBrowser = openInBrowser } = {}) {
  const url = siteUrl();
  const state = await serviceState(url);
  if (state === 'occupied') throw Error(`${url} 的端口被其他服务占用，请更改 FOLIO_WEB_PORT 后重试。`);
  let child = null;
  if (state !== 'ready') {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 19)) throw Error('请先安装 Node.js 24 LTS（最低 22.19）。');
    try {
      await Promise.all(['node_modules/tsx/package.json', 'web/dist/index.html', 'dist/cli.js',
        'pi/node_modules/@earendil-works/pi-coding-agent/package.json'].map(file => access(path.join(root, file))));
    } catch {
      throw Error('首次使用请在项目目录依次执行：\nnpm install\nnpm run setup:pi\nnpm run build:web\n完成后再次双击启动文件。');
    }
    console.log('正在启动 Folio 文档工坊，请稍候…');
    child = spawn(process.execPath, ['--import', 'tsx', 'web/server/main.ts'], { cwd: root, stdio: 'inherit' });
    let spawnError;
    child.once('error', error => { spawnError = error; });
    child.once('exit', code => { if (code) process.exitCode = code; });
    // Ctrl+C reaches the server in this console too. Keep the launcher alive while it closes.
    process.once('SIGINT', () => child.kill('SIGINT'));
    try {
      const deadline = Date.now() + 30000;
      while (true) {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null || child.signalCode !== null) throw Error('服务启动失败，请查看窗口上方的错误信息。');
        const next = await serviceState(url);
        if (next === 'ready') break;
        if (next === 'occupied') throw Error('端口已被其他服务占用，请更改 FOLIO_WEB_PORT 后重试。');
        if (Date.now() >= deadline) throw Error('服务在 30 秒内未就绪，请查看窗口上方的错误信息。');
        await sleep(250);
      }
    } catch (error) { child.kill(); throw error; }
    console.log('服务已就绪。请保留此窗口，按 Ctrl+C 可停止服务。');
  } else console.log('Folio 已在运行，直接打开网页。');
  console.log(url);
  try { await openBrowser(url); }
  catch { console.log(`浏览器未能自动打开，请手动访问：${url}`); }
  return child;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  start().catch(error => { console.error(`\n启动失败：${error.message}`); process.exitCode = 1; });
}

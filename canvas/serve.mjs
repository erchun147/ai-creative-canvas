import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { localApi } from './local-api.mjs';
import { fileURLToPath } from 'node:url';

// 只读取接入记录的非敏感字段，长期Key不进入页面。
function connectedProfile() {
  const name = process.env.CANVAS_PROFILE; if (!name) return false;
  try {
    const file = path.resolve(name), info = fs.lstatSync(file), credential = fs.lstatSync(path.join(path.dirname(file), 'credentials.json'));
    if (!info.isFile() || info.isSymbolicLink() || !credential.isFile() || credential.isSymbolicLink()) return false;
    if (process.platform !== 'win32' && (info.uid !== process.getuid() || credential.uid !== process.getuid() || ((info.mode | credential.mode) & 0o077))) return false;
    if (info.size > 16384) return false;
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    return p.schema === 1 && p.name === 'youkou-media-creator' && Number.isInteger(p.user_id) && p.user_id > 0 && Number.isInteger(p.token_id) && p.token_id > 0 && /^https:\/\/[a-zA-Z0-9.-]+(?::[0-9]{1,5})?\/v1$/.test(p.base_url);
  } catch { return false; }
}
const CONNECTED = connectedProfile();
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const PORT = Number(process.env.PORT || 3101);
const DATA = path.resolve(process.env.CANVAS_DATA_DIR || path.join(os.homedir(), '.local/share/ai-local-canvas'));
let handleLocal;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.avif': 'image/avif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.woff2': 'font/woff2',
};

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  const host = String(req.headers.host || '');
  if (!['127.0.0.1:' + PORT, 'localhost:' + PORT].includes(host)) return send(res, 403, '403', 'text/plain');
  if (req.headers.origin && !['http://127.0.0.1:' + PORT, 'http://localhost:' + PORT].includes(req.headers.origin)) return send(res, 403, '403', 'text/plain');
  let p;
  try { p = decodeURIComponent((req.url || '/').split('?')[0]); } catch { return send(res, 400, '400', 'text/plain'); }
  if (p.includes('\\') || p.includes('\0')) return send(res, 403, '403', 'text/plain');
  if (handleLocal && await handleLocal(req, res, p)) return;
  if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, '405', 'text/plain');
  if (p === '/healthz') return send(res, 200, 'ok', 'text/plain; charset=utf-8');
  if (p === '/' || p === '') p = CONNECTED ? '/index.html' : '/welcome.html';
  const root = ROOT;
  const abs = path.resolve(root, '.' + p);
  if (!abs.startsWith(root + path.sep)) return send(res, 403, '403', 'text/plain');
  try { if (!fs.realpathSync(abs).startsWith(fs.realpathSync(root) + path.sep)) return send(res, 403, '403', 'text/plain'); }
  catch { return send(res, 404, '404', 'text/plain'); }
  let st;
  try { st = fs.statSync(abs); } catch { return send(res, 404, '404 找不到 ' + p, 'text/plain; charset=utf-8'); }
  if (st.isDirectory()) return send(res, 404, '404', 'text/plain');

  const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // SVG可显示为图片；即使直接打开，也隔离脚本与本机画布的项目数据。
  if (path.extname(abs).toLowerCase() === '.svg') res.setHeader('Content-Security-Policy', "default-src 'none'; img-src data: blob: https:; style-src 'unsafe-inline'; sandbox");

  // 视频支持 Range（拖进度条 / Safari 必须）
  const range = req.headers.range;
  if (range && /^bytes=/.test(range)) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return send(res, 416, '416', 'text/plain');
    const start = match[1] ? Number(match[1]) : Math.max(0, st.size - Number(match[2]));
    const end = match[1] && match[2] ? Math.min(Number(match[2]), st.size - 1) : st.size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= st.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Range': `bytes ${start}-${end}/${st.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(abs, { start, end }).on('error', () => res.destroy()).pipe(res);
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': st.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(abs).on('error', () => res.destroy()).pipe(res);
});

const manifest = path.join(path.dirname(fileURLToPath(import.meta.url)), 'canvas-package.json');
const version = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')).version : 'development';
handleLocal = localApi({ root: DATA, port: PORT, server, version, connected: CONNECTED });
server.listen(PORT, '127.0.0.1', () => {
  console.log(`AI 无线发布已启动: http://127.0.0.1:${PORT}`);
  console.log(`根目录: ${ROOT}`);
});

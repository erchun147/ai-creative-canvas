// 仅本机的画布状态接口；复用静态服务进程，无平台密钥、生成或计费能力。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { applyCommand, id } from './src/project-model.js';

const fields = new Set(['orig', 'src', 't64', 't160', 't480', 't1200']);
const types = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml', 'image/avif', 'video/mp4', 'video/webm', 'video/quicktime']);
export function localApi({ root, port, server, version = 'public-2026.11.06.1', connected = false }) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = path.join(root, 'server.lock'), fd = fs.openSync(lock, 'wx', 0o600);
  fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd);
  const token = crypto.randomBytes(32).toString('hex'), origin = 'http://127.0.0.1:' + port;
  const statePath = path.join(root, 'state.json');
  const atomic = (file, bytes) => {
    const temp = file + '.' + crypto.randomUUID() + '.tmp';
    try { fs.writeFileSync(temp, bytes, { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  };
  atomic(path.join(root, 'control.json'), JSON.stringify({ origin, token, pid: process.pid, version }));
  let state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { active: null, projects: {}, receipts: {}, serial: 0 };
  const cleanup = () => { try { fs.unlinkSync(lock); } catch {} };
  process.once('exit', cleanup);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
  const json = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); };
  async function body(req, limit = 2097152) {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > limit) throw Error('请求内容过大'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  function assetPaths(assetId) { id(assetId); return path.join(root, 'assets', assetId); }
  function asset(assetId) {
    const folder = assetPaths(assetId), urls = {};
    if (!fs.existsSync(folder)) return null;
    for (const field of fields) if (fs.existsSync(path.join(folder, field + '.json'))) urls[field] = '/local/v1/assets/' + assetId + '/' + field;
    return { id: assetId, urls };
  }
  return async function handle(req, res, pathname) {
    if (!pathname.startsWith('/local/v1/')) return false;
    try {
      if (!connected && pathname !== '/local/v1/session' && !(pathname === '/local/v1/server' && req.method === 'DELETE')) { json(res, {error:'请先注册账号，并把网站接入命令发给AI完成接入', code:'account_connection_required', registration_url:'https://erchun.youkou.cc'}, 403); return true; }
      const media = /^\/local\/v1\/assets\/([A-Za-z0-9_-]{1,100})\/(orig|src|t64|t160|t480|t1200)$/.exec(pathname);
      // 图片/视频标签不能附Bearer；不可猜测的本机资产ID只开放同源读取。
      if (media && req.method === 'GET') {
        const folder = assetPaths(media[1]), file = path.join(folder, media[2]);
        if (!fs.existsSync(file + '.json')) { json(res, { error: '素材不存在' }, 404); return true; }
        const info = JSON.parse(fs.readFileSync(file + '.json', 'utf8')), stat = fs.statSync(file);
        const headers = { 'Content-Type': info.type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600', 'Accept-Ranges': 'bytes' };
        if (info.type === 'image/svg+xml') headers['Content-Security-Policy'] = "default-src 'none'; img-src data: blob: https:; style-src 'unsafe-inline'; sandbox";
        let start = 0, end = stat.size - 1, code = 200;
        if (req.headers.range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
          if (!match || (!match[1] && !match[2])) { json(res, { error: '无效Range' }, 416); return true; }
          start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
          end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) { json(res, { error: '无效Range' }, 416); return true; }
          code = 206; headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
        }
        res.writeHead(code, { ...headers, 'Content-Length': end - start + 1 });
        fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res); return true;
      }
      if (pathname === '/local/v1/session' && req.method === 'GET') { json(res, { token, protocol: 1, version, account_connected: connected }); return true; }
      if (req.headers.authorization !== 'Bearer ' + token) { json(res, { error: '本机控制令牌无效' }, 401); return true; }
      if (pathname === '/local/v1/state' && req.method === 'GET') json(res, { active: state.active, serial: state.serial });
      else if (pathname === '/local/v1/projects' && req.method === 'GET') json(res, Object.values(state.projects).map(p => ({ id: p.id, name: p.name, revision: p.revision })));
      else if (/^\/local\/v1\/projects\/[A-Za-z0-9_-]+$/.test(pathname) && req.method === 'GET') json(res, state.projects[pathname.split('/').pop()] || null);
      else if (/^\/local\/v1\/receipts\/[A-Za-z0-9_-]+$/.test(pathname) && req.method === 'GET') json(res, state.receipts[pathname.split('/').pop()] || null);
      else if (/^\/local\/v1\/assets\/[A-Za-z0-9_-]+$/.test(pathname) && req.method === 'GET') json(res, asset(pathname.split('/').pop()));
      else if (media && req.method === 'PUT') {
        const type = String(req.headers['content-type'] || '').split(';')[0];
        if (!types.has(type)) throw Error('不支持的素材格式');
        const bytes = await body(req, 512 * 1024 * 1024); if (!bytes.length) throw Error('素材为空');
        const folder = assetPaths(media[1]); fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
        const file = path.join(folder, media[2]);
        if (fs.existsSync(file) && !fs.readFileSync(file).equals(bytes)) throw Error('已有素材不能覆盖');
        atomic(file, bytes); atomic(file + '.json', JSON.stringify({ type })); json(res, { ok: true, url: pathname });
      } else if (pathname === '/local/v1/commands' && req.method === 'POST') {
        const command = JSON.parse((await body(req)).toString('utf8'));
        id(command.id); id(command.project_id);
        const old = state.receipts[command.id], input = crypto.createHash('sha256').update(JSON.stringify(command)).digest('hex');
        if (old) { if (old.input !== input && crypto.createHash('sha256').update(old.input).digest('hex') !== input) throw Error('命令ID已用于不同内容'); json(res, { ...old.result, duplicate: true }); return true; }
        if (Object.keys(state.receipts).length >= 20000) throw Error('本地回执已满，请先备份归档');
        const project = { ...applyCommand(state.projects[command.project_id], command), kind: 'project', updated_at: new Date().toISOString() };
        const result = { ok: true, command_id: command.id, project_id: project.id, revision: project.revision };
        const next = { ...state, active: project.id, serial: state.serial + 1,
          projects: { ...state.projects, [project.id]: project }, receipts: { ...state.receipts, [command.id]: { input, result } } };
        const bytes = JSON.stringify(next); if (bytes.length > 64 * 1024 * 1024) throw Error('项目库过大，请先备份归档');
        atomic(statePath, bytes); state = next; json(res, result);
      } else if (pathname === '/local/v1/server' && req.method === 'DELETE') { json(res, { ok: true }); setImmediate(() => server.close(() => process.exit(0))); }
      else json(res, { error: '本地接口不存在' }, 404);
    } catch (e) { json(res, { error: e.message }, 400); }
    return true;
  };
}

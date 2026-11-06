#!/usr/bin/env node
// 直接调用本机端口；控制令牌只在进程内传递，不要求AI操作浏览器。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const [action, ...argv] = process.argv.slice(2);
const opt = name => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : null; };
try {
  if (!opt('data')) throw Error('需要 --data 本地数据目录');
  const file = path.join(path.resolve(opt('data')), 'control.json'), info = fs.lstatSync(file);
  if (info.isSymbolicLink() || !info.isFile() || (process.platform !== 'win32' && (info.uid !== process.getuid() || (info.mode & 0o077)))) throw Error('本机控制记录权限不安全');
  const control = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(control.origin) || !/^[a-f0-9]{64}$/.test(control.token)) throw Error('本机控制记录无效');
  const request = async (route, { method = 'GET', body, type = 'application/json' } = {}) => {
    const response = await fetch(control.origin + '/local/v1' + route, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: 'Bearer ' + control.token, 'Content-Type': type }, body });
    const value = await response.json(); if (!response.ok) throw Error(value.error || '本机接口失败'); return value;
  };
  let result;
  if (action === 'projects') result = await request('/projects');
  else if (action === 'state') { const s = await request('/state'); result = s.active ? await request('/projects/' + s.active) : s; }
  else if (action === 'stop') result = await request('/server', { method: 'DELETE' });
  else if (action === 'receipt') result = await request('/receipts/' + encodeURIComponent(opt('id')));
  else if (action === 'media') {
    const input = opt('file'), ext = path.extname(input || '').toLowerCase();
    const mime = { '.svg':'image/svg+xml', '.gif':'image/gif', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.avif':'image/avif', '.mp4':'video/mp4', '.webm':'video/webm', '.mov':'video/quicktime' }[ext];
    if (!mime || fs.statSync(input).size > 512 * 1024 * 1024) throw Error('素材格式无效或超过512MB');
    const id = crypto.randomUUID(), video = mime.startsWith('video/');
    result = await request('/assets/' + id + '/' + (video ? 'src' : 'orig'), { method: 'PUT', body: fs.readFileSync(input), type: mime });
    result = { ...result, asset_id: id, type: video ? 'video' : 'image', data: { asset_id: id, title: path.basename(input), ...(video ? { src: result.url } : { orig: result.url, t64: result.url, t160: result.url, t480: result.url, t1200: result.url }) } };
  } else {
    let command;
    if (action === 'send') {
      if (!opt('file') || fs.statSync(opt('file')).size > 2097152) throw Error('需要2MB以内的JSON命令 --file');
      command = JSON.parse(fs.readFileSync(opt('file'), 'utf8'));
    } else if (action === 'new') command = { type:'project.create', project_id:crypto.randomUUID(), name:opt('name') || '新的创作项目' };
    else if (action === 'open') command = { type:'project.open', project_id:opt('id') };
    else if (action === 'arrange') command = { type:'graph.arrange', project_id:opt('id'), layout:opt('layout') || 'storyboard', columns:Number(opt('columns')) || 4 };
    else throw Error('用法：node canvas.mjs projects|state|new|open|send|media|arrange|receipt|stop --data <目录>');
    command.protocol ??= 1; command.id ||= crypto.randomUUID();
    result = await request('/commands', { method:'POST', body:JSON.stringify(command) });
    // API回执表示已落盘；只有打开的浏览器实际同步后才能声称画面已显示。
  }
  console.log(JSON.stringify(result));
} catch (error) { console.error(JSON.stringify({ok:false,message:error.message})); process.exitCode=1; }

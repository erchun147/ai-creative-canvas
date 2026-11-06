#!/usr/bin/env python3
"""显式清单校验独立公开包；不读取工作区外任何网站文件。"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
ROOT = Path(__file__).resolve().parents[1]
EXACT = {'README.md','LICENSE','NOTICE.md','THIRD_PARTY_NOTICES.txt','PUBLICATION_MANIFEST.json',
         'scripts/onboard.py','scripts/client-installer.py','scripts/audit-release.py','tests/test_onboarding.py',
         'skills/youkou-media-creator/SKILL.md','skills/youkou-media-creator/references/creative-rules.md',
         'canvas/AGENT.md','canvas/LICENSE','canvas/THIRD_PARTY_NOTICES.txt','canvas/canvas.mjs','canvas/local-api.mjs',
         'canvas/serve.mjs','canvas/test.mjs','canvas/index.html','canvas/vite.config.js','canvas/package.json','canvas/package-lock.json',
         'canvas/src/App.jsx','canvas/src/main.jsx','canvas/src/canvas.css','canvas/src/useCull.js','canvas/src/OverviewLayer.jsx',
         'canvas/src/project-model.js','canvas/src/project-store.js','canvas/src/media.js','canvas/src/useProjects.js',
         'canvas/public/welcome.html','canvas/dist/welcome.html','canvas/dist/index.html'}
PATTERNS = [re.compile(r'canvas/(?:public|dist)/demo/sample[0-9]\.svg\Z'),re.compile(r'canvas/dist/a/index-[A-Za-z0-9_-]+\.(?:js|css)\Z')]
SECRET = [re.compile(r'sk-[a-fA-F0-9]{64}'), re.compile(r'(?:aic|ais)_[a-f0-9]{48}'),
          re.compile(r'(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}'),re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
          re.compile(r'https?://[^/\s]+:[^/\s]+@'),re.compile(r'manage-[a-f0-9]{20,}')]
BLOCKED_PARTS={'node_modules','__pycache__','.env','storage','runtime','uploads','app','routes','config','.github'}

def inspect():
    files={}
    for path in sorted(ROOT.rglob('*')):
        parts=path.relative_to(ROOT).parts
        if parts[0]=='.git':continue
        if path.is_symlink():raise ValueError('拒绝发布符号链接：'+str(path.relative_to(ROOT)))
        if any(p in BLOCKED_PARTS for p in parts):raise ValueError('拒绝发布运行/网站/依赖目录：'+str(path.relative_to(ROOT)))
        if not path.is_file():continue
        name=path.relative_to(ROOT).as_posix()
        if name not in EXACT and not any(p.fullmatch(name) for p in PATTERNS):raise ValueError('不在公开文件清单：'+name)
        raw=path.read_bytes()
        try:text=raw.decode('utf-8')
        except UnicodeDecodeError:raise ValueError('公开包只允许经核验的UTF8源码和矢量示例：'+name)
        if any(p.search(text) for p in SECRET):raise ValueError('发现疑似凭据，停止发布：'+name)
        if ('/Users/'+'k/') in text or ('/www/'+'wwwroot/') in text:raise ValueError('发现原机器或生产目录，停止发布：'+name)
        if name!='PUBLICATION_MANIFEST.json':files[name]=hashlib.sha256(raw).hexdigest()
    required=EXACT-{'PUBLICATION_MANIFEST.json'}
    if not required.issubset(files):raise ValueError('缺少必要文件：'+str(sorted(required-set(files))))
    if len([n for n in files if n.startswith('canvas/dist/a/') and n.endswith('.js')])!=1:raise ValueError('编译入口数量异常')
    return files

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--write-manifest',action='store_true');args=parser.parse_args()
    try:
        files=inspect();path=ROOT/'PUBLICATION_MANIFEST.json'
        if args.write_manifest:
            path.write_text(json.dumps({'scope':'standalone Skill, local canvas and client tools only','version':'public-2026.11.06.2','files':files},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        else:
            manifest=json.loads(path.read_text(encoding='utf-8'))
            if manifest.get('files')!=files:raise ValueError('文件变化或缺失，与已审阅清单不一致')
        print('PASS: '+str(len(files))+' allowlisted files; no website backend, history, runtime data or credential patterns')
        return 0
    except Exception as error:
        print('FAIL: '+str(error),file=sys.stderr);return 1
if __name__=='__main__':sys.exit(main())

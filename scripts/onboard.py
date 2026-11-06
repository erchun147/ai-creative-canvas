#!/usr/bin/env python3
"""独立客户端引导、离线规则安装和本人画布启动；无平台后端能力。"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('client', ROOT / 'scripts/client-installer.py')
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)
REGISTER = 'https://erchun.youkou.cc'


def guidance():
    return {'ok': False, 'status': 'needs_registration', 'registration_url': REGISTER,
            'steps': ['注册并登录网站', '打开开放API的一键AI对接', '复制接入命令', '把命令发给有本机权限的AI'],
            'open_api_url': REGISTER + '/user/open-api#api-ai-connect'}


def profile_file(value):
    path = Path(value).absolute()
    client.private(path.parent, True)
    profile = client.read_json(path)
    if profile.get('schema') != 1 or profile.get('name') != client.SKILL_NAME:
        raise ValueError('缺少可信接入记录，请从原站点重新接入')
    client.api_base(profile.get('base_url'))
    if not all(type(profile.get(k)) is int and profile[k] > 0 for k in ['user_id', 'token_id']):
        raise ValueError('账号安装记录无效')
    # 不把凭据读到输出或模型上下文；只确认领取工具已生成私有凭据文件。
    client.private(path.parent / 'credentials.json')
    return path, profile


def bundled_skill(path):
    folder = path.parent
    with client.update_lock(folder):
        skill_dir = client.directory(folder / 'skill')
        skill = skill_dir / 'SKILL.md'
        installed = folder / 'installed.json'
        if skill.exists() or installed.exists():
            if not skill.exists() or not installed.exists():
                raise ValueError('已有规则不完整，保留原文件，请核验后恢复')
            record = client.read_json(installed)
            client.private(skill)
            if hashlib.sha256(skill.read_bytes()).hexdigest() != record.get('sha256'):
                raise ValueError('已有规则被修改，保留原文件')
            return {'status': 'existing', 'skill_path': str(skill), 'version': record.get('version'), 'latest_verified': False}
        data = (ROOT / 'skills/youkou-media-creator/references/creative-rules.md').read_bytes()
        import re
        match = re.search(rb'  version: "([0-9.]+)"', data)
        if not match or not data.startswith(b'---\nname: youkou-media-creator\n'):
            raise ValueError('附带规则无效')
        client.write_private(skill, data)
        version = match[1].decode()
        client.write_private(installed, client.encode({'version': version, 'sha256': hashlib.sha256(data).hexdigest()}))
        return {'status': 'bundled_offline', 'skill_path': str(skill), 'version': version, 'latest_verified': False,
                'message': '安装了仓库附带版本，未核验最新版本；原Key及作品保持'}


def start_canvas(path, profile, node_path=None):
    saved = profile.get('canvas_runtime', {})
    node = node_path or saved.get('node')
    report = client.environment_report(node)
    if not report['canvas_runtime_ready']:
        return {'ok': False, 'status': 'runtime_missing', 'environment': report}
    node = str(Path(report['node_path']).absolute())
    home = client.directory(path.parent / 'canvas')
    data = client.directory(home / 'data')
    saved_port = saved.get('port')
    port = saved_port if type(saved_port) is int and 1024 <= saved_port <= 65535 else 20000 + int(hashlib.sha256(str(path.parent).encode()).hexdigest()[:6], 16) % 20000
    program = ROOT / 'canvas/serve.mjs'
    installed = home / 'installed.json'
    if installed.exists():
        record = client.read_json(installed, 262144)
        version = record.get('version')
        if not isinstance(version, str) or not client.VERSION.fullmatch(version):
            raise ValueError('已有画布版本记录无效')
        release = client.private(home / 'releases' / version, True)
        files = record.get('files')
        if not isinstance(files, dict) or 'serve.mjs' not in files:
            raise ValueError('已有画布校验清单无效')
        for relative, digest in files.items():
            part = Path(relative)
            if part.is_absolute() or '..' in part.parts or '\\' in relative:
                raise ValueError('已有画布文件路径无效')
            file = client.private(release / part)
            if hashlib.sha256(file.read_bytes()).hexdigest() != digest:
                raise ValueError('已有画布被修改，保留文件并停止覆盖')
        program = release / 'serve.mjs'
        if type(record.get('port')) is int and 1024 <= record['port'] <= 65535:
            port = record['port']
    origin = 'http://127.0.0.1:' + str(port)
    control_path = data / 'control.json'
    if control_path.exists():
        control = client.read_json(control_path)
        if control.get('origin') != origin:
            raise ValueError('已有本机控制记录与端口不一致，保留记录并核验')
        try:
            req = urllib.request.Request(origin + '/local/v1/state', headers={'Authorization': 'Bearer ' + control['token']})
            with urllib.request.build_opener(client.NoRedirect()).open(req, timeout=2) as response:
                if response.status == 200:
                    return {'ok': True, 'status': 'running', 'url': origin + '/', 'data_dir': str(data)}
        except Exception:
            pass
    if (data / 'server.lock').exists():
        raise ValueError('已有服务锁，先核验原服务归属；不会自动删锁或杀进程')
    env = dict(os.environ, PORT=str(port), CANVAS_DATA_DIR=str(data), CANVAS_PROFILE=str(path))
    log = data / 'server.log'
    if log.exists():
        client.private(log)
    fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    if os.name == 'nt':
        client._windows_acl(log, True)
    with os.fdopen(fd, 'ab') as output:
        proc = subprocess.Popen([node, str(program)], env=env, stdout=output, stderr=output,
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    for _ in range(100):
        if proc.poll() is not None:
            raise ValueError('画布未启动，可能端口占用；查看本人私有日志，不停止其他程序')
        if control_path.exists():
            control = client.read_json(control_path)
            if control.get('pid') == proc.pid and control.get('origin') == origin:
                try:
                    req = urllib.request.Request(origin + '/local/v1/state', headers={'Authorization': 'Bearer ' + control['token']})
                    with urllib.request.build_opener(client.NoRedirect()).open(req, timeout=1) as response:
                        if response.status == 200:
                            # 保留用户其他设置，不因启动重写密钥或创作偏好。
                            profile['canvas_runtime'] = dict(saved, node=node, port=port)
                            client.write_private(path, client.encode(profile))
                            return {'ok': True, 'status': 'started', 'url': origin + '/', 'data_dir': str(data)}
                except Exception:
                    pass
        time.sleep(.05)
    raise ValueError('尚未确认启动成功，保留现场，不重复启动')


def main():
    parser = argparse.ArgumentParser(description='注册指引与本人本地画布启动')
    parser.add_argument('--doctor', action='store_true')
    parser.add_argument('--profile')
    parser.add_argument('--node')
    parser.add_argument('--install-bundled-skill', action='store_true')
    parser.add_argument('--start', action='store_true')
    args = parser.parse_args()
    try:
        if args.doctor:
            result = client.environment_report(args.node)
        elif not args.profile:
            result = guidance()
        else:
            path, profile = profile_file(args.profile)
            result = {'ok': True, 'profile_path': str(path)}
            if args.install_bundled_skill:
                result['skill'] = bundled_skill(path)
            if args.start:
                result.update(start_canvas(path, profile, args.node))
    except Exception as error:
        result = {'ok': False, 'status': 'setup_incomplete', 'message': str(error)}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get('ok') else 1


if __name__ == '__main__':
    sys.exit(main())

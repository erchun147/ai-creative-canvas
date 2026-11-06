#!/usr/bin/env python3
"""本机接入和只读Skill更新。密钥只由本进程与用户私有凭据文件传递。"""
import argparse
import contextlib
import hashlib
import io
import json
import os
import platform
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import shutil
import zipfile
import urllib.error
import urllib.parse
import urllib.request

UPDATER_VERSION = 2
SKILL_NAME = "youkou-media-creator"
VERSION = re.compile(r"[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]+\Z")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class UpdateFailure(Exception):
    def __init__(self, status):
        self.status = status


def api_base(value):
    if not isinstance(value, str) or not re.fullmatch(r"https://[a-zA-Z0-9.-]+(?::[0-9]{1,5})?/v1", value):
        raise ValueError("API地址无效")
    return value


def private(path, directory=False):
    """不跟随凭据或配置链接；现有权限过宽时拒绝读取，不擅自收紧其他文件。"""
    path = Path(path)
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or (directory and not stat.S_ISDIR(info.st_mode)) or (not directory and not stat.S_ISREG(info.st_mode)):
        raise ValueError("本地私有路径无效")
    if os.name != "nt":
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
            raise ValueError("本地文件权限过宽")
    else:
        _windows_acl(path, False)
    return path


def _windows_acl(path, create):
    # 路径通过环境传递，不拼进PowerShell代码；只准当前SID访问新建凭据对象。
    env = dict(os.environ, YOUKOU_PRIVATE_PATH=str(path), YOUKOU_PRIVATE_CREATE="1" if create else "0")
    script = r'''$ErrorActionPreference='Stop'; $p=$env:YOUKOU_PRIVATE_PATH;
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
if ($env:YOUKOU_PRIVATE_CREATE -eq '1') {
  if ((Get-Item -LiteralPath $p).PSIsContainer) {
    $acl=New-Object System.Security.AccessControl.DirectorySecurity;
    $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow');
  } else {
    $acl=New-Object System.Security.AccessControl.FileSecurity;
    $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow');
  }
  $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl;
}
$acl=Get-Acl -LiteralPath $p;
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) {exit 2}
foreach ($r in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {
 if ($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Value -ne $sid.Value) {exit 3}
}'''
    result = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15, check=False)
    if result.returncode:
        raise ValueError("Windows私有权限未确认")


def directory(path):
    path = Path(path)
    if not path.exists() and not path.is_symlink():
        path.mkdir(mode=0o700)
        if os.name == "nt": _windows_acl(path, True)
    return private(path, True)


def secure_store(root=None):
    """先确认可写私有目录，成功后才消费一次性凭据；不访问任何钥匙串。"""
    if root is None:
        parent = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData/Local"))) if os.name == "nt" else Path.home() / ".config"
        parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        root = parent / "youkou-media"
    root = directory(root)
    directory(root / "accounts")
    return root


def write_private(path, data):
    path = Path(path)
    private(path.parent, True)
    if path.exists() or path.is_symlink(): private(path)
    fd, temp = tempfile.mkstemp(prefix=".youkou-", dir=path.parent)
    try:
        if os.name == "nt": _windows_acl(temp, True)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp): os.unlink(temp)


def read_json(path, limit=16384):
    private(path)
    if Path(path).stat().st_size > limit: raise ValueError("本地配置过长")
    return json.loads(Path(path).read_text(encoding="utf-8"))


def encode(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()


def fetch_json(url, key=None, opener=None, limit=262144, body=None):
    headers = {"Accept": "application/json"}
    if key: headers["Authorization"] = "Bearer " + key
    request = urllib.request.Request(url, data=body, headers=headers, method="GET" if body is None else "POST")
    try:
        with (opener or urllib.request.build_opener(NoRedirect())).open(request, timeout=20) as response:
            if response.status != 200: raise UpdateFailure("http_error")
            if hasattr(response, "geturl") and response.geturl() != url: raise UpdateFailure("redirect_rejected")
            raw = response.read(limit + 1)
            if len(raw) > limit: raise ValueError("响应过长")
            return json.loads(raw)
    except urllib.error.HTTPError as error:
        raise UpdateFailure({401: "auth_required", 403: "permission_denied", 404: "updates_unavailable"}.get(error.code, "http_error")) from None


def connect(config, store=None, opener=None, root=None):
    endpoint, code = config.get("endpoint"), config.get("code")
    if not isinstance(endpoint, str) or not isinstance(code, str): raise ValueError("领取信息无效")
    parts = urllib.parse.urlsplit(endpoint)
    if (parts.scheme != "https" or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment
            or parts.path != "/api/ai-connect/credential" or not re.fullmatch(r"ais_[a-f0-9]{48}", code)):
        raise ValueError("领取信息无效")
    base = api_base(config.get("base_url", urllib.parse.urlunsplit((parts.scheme, parts.netloc, "/v1", "", ""))))
    home = secure_store(root) if store is None else None
    payload = fetch_json(endpoint, opener=opener, limit=16384, body=urllib.parse.urlencode({"code": code}).encode())
    key = payload.get("api_key")
    if (payload.get("base_url") != base or not isinstance(key, str) or not re.fullmatch(r"sk-[a-f0-9]{64}", key)
            or type(payload.get("user_id")) is not int or payload["user_id"] < 1
            or type(payload.get("token_id")) is not int or payload["token_id"] < 1): raise ValueError("领取响应无效")
    service = "youkou-open-api:" + urllib.parse.urlsplit(base).netloc
    account = "user-{}-key-{}".format(payload["user_id"], payload["token_id"])
    if store is not None:  # 合成测试存储适配器，不用于产品钥匙串。
        store[1](service, account, key)
        return {"ok": True, "base_url": base, "credential_store": store[0], "service": service, "account": account}
    identity = hashlib.sha256((base + "\n" + account).encode()).hexdigest()[:24]
    folder = directory(home / "accounts" / identity)
    skill = directory(folder / "skill")
    profile = {"schema": 1, "name": SKILL_NAME, "base_url": base, "user_id": payload["user_id"], "token_id": payload["token_id"],
               "site_origin": urllib.parse.urlunsplit((parts.scheme, parts.netloc, "", "", "")), "auto_update": True,
               "updater_path": str(Path(__file__).resolve())}
    profile_path = folder / "profile.json"
    if profile_path.exists():
        current = read_json(profile_path)
        if any(current.get(k) != profile[k] for k in ["name", "base_url", "user_id", "token_id", "site_origin"]): raise ValueError("已有配置身份不匹配")
        profile = current  # 保留个人偏好、已确认副本目录和自动更新设置。
        profile.setdefault("updater_path", str(Path(__file__).resolve()))
    write_private(folder / "credentials.json", encode({"api_key": key}))
    write_private(profile_path, encode(profile))
    return {"ok": True, "base_url": base, "credential_store": "private_file", "profile_path": str(profile_path),
            "credentials_file": str(folder / "credentials.json"), "skill_path": str(skill / "SKILL.md"),
            "copy_locator": {"profile_path": str(profile_path)},
            "update_command": [sys.executable, str(Path(__file__).resolve()), "--update", str(profile_path)]}


@contextlib.contextmanager
def update_lock(folder):
    path = folder / "update.lock"
    if path.exists() or path.is_symlink(): private(path)
    fd = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        if os.name == "nt":
            import msvcrt
            _windows_acl(path, True)
            if os.fstat(fd).st_size == 0: os.write(fd, b"0")
            os.lseek(fd, 0, 0)
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    except BlockingIOError:
        raise UpdateFailure("update_busy") from None
    finally:
        os.close(fd)


def manifest(value):
    if (not isinstance(value, dict) or value.get("object") not in ["skill.version", "skill.release"] or value.get("name") != SKILL_NAME
            or not isinstance(value.get("version"), str) or not VERSION.fullmatch(value["version"])
            or not re.fullmatch(r"[a-f0-9]{64}", str(value.get("sha256", "")))
            or type(value.get("size_bytes")) is not int or not 1 <= value["size_bytes"] <= 131072
            or type(value.get("min_updater_version")) is not int or value["min_updater_version"] < 1
            or value.get("update_kind") != "instructions"):
        raise UpdateFailure("invalid_release")
    if value["min_updater_version"] > UPDATER_VERSION: raise UpdateFailure("updater_upgrade_required")
    return value


def version_tuple(value):
    if not isinstance(value, str) or not VERSION.fullmatch(value): raise UpdateFailure("invalid_release")
    return tuple(int(part) for part in value.split('.'))


def copy_targets(profile, skill, allowed):
    values = profile.get("skill_copies", [])
    if not isinstance(values, list): raise ValueError("副本配置无效")
    result, seen = [], set()
    for value in values:
        if not isinstance(value, str): raise ValueError("副本路径无效")
        path = Path(value)
        if not path.is_absolute() or path.name != "SKILL.md" or path == skill or str(path) in seen: raise ValueError("副本路径无效")
        seen.add(str(path)); private(path.parent, True); private(path)
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() not in allowed: raise UpdateFailure("local_copy_modified")
        result.append((path, data))
    return result


def update(profile_path, opener=None):
    profile_path = Path(profile_path).absolute()
    folder = private(profile_path.parent, True)
    profile = read_json(profile_path)
    if profile.get("schema") != 1 or profile.get("name") != SKILL_NAME: raise ValueError("本地配置无效")
    base = api_base(profile.get("base_url"))
    if profile.get("auto_update") is False: return {"ok": True, "status": "disabled"}
    key = read_json(folder / "credentials.json").get("api_key")
    if not isinstance(key, str) or not re.fullmatch(r"sk-[a-f0-9]{64}", key): raise ValueError("本地凭据无效")
    with update_lock(folder):
        remote = manifest(fetch_json(base + "/skill/version", key, opener, limit=16384))
        expected = "/skill/releases/" + remote["version"]
        if remote.get("object") != "skill.version" or remote.get("download_path") != expected: raise UpdateFailure("invalid_release")
        skill = directory(folder / "skill") / "SKILL.md"
        state_path = folder / "installed.json"
        state = read_json(state_path) if state_path.exists() else {}
        old = None
        if skill.exists() or skill.is_symlink():
            private(skill); old = skill.read_bytes()
            digest = hashlib.sha256(old).hexdigest()
            actual = re.search(rb'^  version: "([0-9.]+)"$', old, re.M)
            if actual is None: raise UpdateFailure("local_skill_modified")
            current_version = actual[1].decode()
            if digest == remote["sha256"] and current_version == remote["version"]:
                # 上次正文已原子落盘但状态回执丢失时，只修复状态，不重复安装。
                copies = copy_targets(profile, skill, {digest, state.get("sha256")})
                changed = [(path, data) for path, data in copies if data != old]
                done = []
                try:
                    for target, previous in changed:
                        backups = directory(folder / "backups")
                        write_private(backups / (hashlib.sha256(previous).hexdigest() + ".md"), previous)
                        write_private(target, old); done.append((target, previous))
                    write_private(state_path, encode({"version": current_version, "sha256": digest}))
                except Exception:
                    for target, previous in reversed(done): write_private(target, previous)
                    raise
                reload = bool(changed) or state.get("version") != current_version or state.get("sha256") != digest
                return {"ok": True, "status": "updated" if changed else "current", "version": current_version,
                        "skill_path": str(skill), "reload_required": reload}
            if version_tuple(current_version) >= version_tuple(remote["version"]): raise UpdateFailure("downgrade_or_changed_version")
            if digest != state.get("sha256") or current_version != state.get("version"): raise UpdateFailure("local_skill_modified")
        release = manifest(fetch_json(base + expected, key, opener))
        for field in ["name", "version", "sha256", "size_bytes", "min_updater_version", "update_kind"]:
            if release.get(field) != remote.get(field): raise UpdateFailure("release_changed")
        content = release.get("content")
        if release.get("object") != "skill.release" or not isinstance(content, str): raise UpdateFailure("invalid_release")
        data = content.encode()
        if (len(data) != remote["size_bytes"] or hashlib.sha256(data).hexdigest() != remote["sha256"]
                or not data.startswith(b"---\nname: youkou-media-creator\n")
                or ('  version: "' + remote["version"] + '"\n') not in content): raise UpdateFailure("checksum_mismatch")
        # 非链接宿主的完整副本由首次安装记录授权，用户自己修改过的副本不覆盖。
        targets = [skill] + [target for target, _ in copy_targets(profile, skill,
            {hashlib.sha256(old).hexdigest()} if old is not None else set())]
        backups = directory(folder / "backups")
        if old is not None:
            write_private(backups / (hashlib.sha256(old).hexdigest() + ".md"), old)
        done = []
        try:
            for target in targets:
                write_private(target, data); done.append(target)
            write_private(state_path, encode({"version": remote["version"], "sha256": remote["sha256"]}))
        except Exception:
            for target in reversed(done):
                if old is not None: write_private(target, old)
                else: target.unlink()
            if state:
                write_private(state_path, encode(state))
            elif state_path.exists():
                state_path.unlink()
            raise
        return {"ok": True, "status": "updated", "version": remote["version"], "skill_path": str(skill), "reload_required": True}


def canvas_update(profile_path, opener=None):
    """同源下载、校验后安装独立版本；不执行程序，不覆盖作品和运行数据。"""
    profile_path = Path(profile_path).absolute()
    folder = private(profile_path.parent, True)
    profile = read_json(profile_path)
    if profile.get("schema") != 1 or profile.get("name") != SKILL_NAME: raise ValueError("本地配置无效")
    if profile.get("auto_update") is False: return {"ok": True, "status": "disabled"}
    base = api_base(profile.get("base_url"))
    key = read_json(folder / "credentials.json").get("api_key")
    if not isinstance(key, str) or not re.fullmatch(r"sk-[a-f0-9]{64}", key): raise ValueError("本地凭据无效")
    with update_lock(folder):
        meta = fetch_json(base + "/canvas/version", key, opener, limit=16384)
        version = meta.get("version")
        if (meta.get("object") != "canvas.version" or not isinstance(version, str) or not VERSION.fullmatch(version)
                or type(meta.get("size_bytes")) is not int or not 1 <= meta["size_bytes"] <= 16777216
                or not re.fullmatch(r"[a-f0-9]{64}", str(meta.get("sha256", "")))
                or type(meta.get("min_updater_version")) is not int or meta["min_updater_version"] < 2
                or meta.get("download_path") != "/canvas/releases/" + version): raise UpdateFailure("invalid_canvas_release")
        if meta["min_updater_version"] > UPDATER_VERSION: raise UpdateFailure("updater_upgrade_required")
        home = directory(folder / "canvas")
        releases = directory(home / "releases")
        data_dir = directory(home / "data")
        installed_path = home / "installed.json"
        installed = read_json(installed_path, 262144) if installed_path.exists() else None
        required = {"dist/index.html", "serve.mjs", "canvas.mjs", "local-api.mjs", "src/project-model.js", "package.json"}
        if installed:
            if not isinstance(installed.get("files"), dict) or not required.issubset(installed["files"]): raise UpdateFailure("invalid_canvas_state")
            old_version = installed.get("version")
            if version_tuple(version) < version_tuple(old_version): raise UpdateFailure("canvas_downgrade_rejected")
            if version == old_version and meta["sha256"] != installed.get("sha256"): raise UpdateFailure("canvas_release_changed")
            old_dir = private(releases / old_version, True)
            for relative, digest in installed.get("files", {}).items():
                part = Path(relative)
                if part.is_absolute() or ".." in part.parts or "\\" in relative: raise UpdateFailure("invalid_canvas_state")
                actual = private(old_dir / part)
                if hashlib.sha256(actual.read_bytes()).hexdigest() != digest: raise UpdateFailure("local_canvas_modified")
            if version == old_version:
                return {"ok": True, "status": "current", "version": version, "release_dir": str(old_dir), "data_dir": str(data_dir), "port": installed["port"], "start_command": ["node", str(old_dir / "serve.mjs")], "start_environment": {"PORT": str(installed["port"]), "CANVAS_DATA_DIR": str(data_dir)}}
        url = base + meta["download_path"]
        req = urllib.request.Request(url, headers={"Authorization": "Bearer " + key, "Accept": "application/zip"})
        try:
            with (opener or urllib.request.build_opener(NoRedirect())).open(req, timeout=30) as response:
                if response.status != 200 or (hasattr(response, "geturl") and response.geturl() != url): raise UpdateFailure("redirect_rejected")
                raw = response.read(meta["size_bytes"] + 1)
        except urllib.error.HTTPError as e:
            raise UpdateFailure({401: "auth_required", 403: "permission_denied", 404: "updates_unavailable"}.get(e.code, "http_error")) from None
        if len(raw) != meta["size_bytes"] or hashlib.sha256(raw).hexdigest() != meta["sha256"]: raise UpdateFailure("canvas_checksum_mismatch")
        target = releases / version
        if target.exists() or target.is_symlink(): raise UpdateFailure("canvas_version_directory_exists")
        stage = directory(releases / ("staging-" + os.urandom(12).hex()))
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                entries = archive.infolist()
                if not 1 <= len(entries) <= 1000 or sum(v.file_size for v in entries) > 67108864: raise UpdateFailure("invalid_canvas_archive")
                names = [v.filename for v in entries]
                if len(names) != len(set(names)): raise UpdateFailure("invalid_canvas_archive")
                for entry in entries:
                    relative = Path(entry.filename)
                    if (relative.is_absolute() or not entry.filename or ".." in relative.parts or "\\" in entry.filename or ":" in entry.filename
                            or entry.is_dir() or stat.S_ISLNK(entry.external_attr >> 16)
                            or not re.fullmatch(r"[A-Za-z0-9_./-]+", entry.filename)):
                        raise UpdateFailure("invalid_canvas_archive")
                    destination = stage / relative
                    for parent in reversed(destination.relative_to(stage).parents):
                        if str(parent) != ".": directory(stage / parent)
                    write_private(destination, archive.read(entry))
            package = read_json(stage / "canvas-package.json", 262144)
            files = package.get("files", {})
            required = {"dist/index.html", "serve.mjs", "canvas.mjs", "local-api.mjs", "src/project-model.js", "package.json"}
            if package.get("version") != version or package.get("protocol") != 1 or not isinstance(files, dict) or not required.issubset(files) or set(files) != set(names) - {"canvas-package.json"}:
                raise UpdateFailure("invalid_canvas_archive")
            for relative, digest in files.items():
                if not isinstance(digest, str) or hashlib.sha256((stage / relative).read_bytes()).hexdigest() != digest: raise UpdateFailure("canvas_checksum_mismatch")
            os.replace(stage, target)
            # 原账号固定端口用于保持浏览器来源；端口冲突时不停止其它程序。
            port = installed["port"] if installed else 20000 + int(hashlib.sha256(str(folder).encode()).hexdigest()[:6], 16) % 20000
            write_private(installed_path, encode({"version": version, "sha256": meta["sha256"], "files": files, "port": port}))
        finally:
            if stage.exists(): shutil.rmtree(stage)
        return {"ok": True, "status": "updated", "version": version, "release_dir": str(target), "data_dir": str(data_dir), "port": port,
                "start_command": ["node", str(target / "serve.mjs")],
                "start_environment": {"PORT": str(port), "CANVAS_DATA_DIR": str(data_dir)}, "restart_required": bool(installed)}


def environment_report(node_path=None):
    """只检查已有环境，不联网、不读取Key、不擅自安装或申请管理员权限。"""
    executable = node_path or shutil.which("node")
    node_version = None
    if executable:
        try:
            value = subprocess.run([executable, "--version"], capture_output=True, text=True, timeout=5, check=False)
            match = re.fullmatch(r"v([0-9]+)\.[0-9]+\.[0-9]+", value.stdout.strip())
            if value.returncode == 0 and match: node_version = value.stdout.strip()
        except (OSError, subprocess.TimeoutExpired): pass
    major = int(node_version[1:].split(".")[0]) if node_version else None
    return {"ok": True, "os": platform.system(), "arch": platform.machine(), "python": platform.python_version(),
            "python_path": sys.executable, "node": node_version, "node_path": executable,
            "canvas_runtime_ready": sys.version_info >= (3, 9) and major is not None and major >= 18,
            "requires_npm_install": False, "requires_browser_plugin": False,
            "notice": "缺环境时先准备官方仍受支持的Python3与Node LTS，优先本人目录，不更改系统既有版本；管理员权限或受管设备限制须由用户确认。此检查不安装、不联网、不读取凭据。"}


def main():
    parser = argparse.ArgumentParser(description="本地私有凭据接入与只读Skill更新")
    parser.add_argument('--update', metavar='PROFILE')
    parser.add_argument('--canvas', metavar='PROFILE')
    parser.add_argument('--doctor', action='store_true')
    parser.add_argument('--node', metavar='EXECUTABLE')
    args = parser.parse_args()
    if sum([bool(args.update), bool(args.canvas), bool(args.doctor)]) > 1: parser.error('一次只运行一种操作')
    if args.node and not args.doctor: parser.error('--node只用于--doctor')
    try:
        if args.doctor:
            result = environment_report(args.node)
        elif args.canvas:
            result = canvas_update(args.canvas)
        elif args.update:
            result = update(args.update)
        else:
            value = sys.stdin.read(8193)
            if len(value) > 8192: raise ValueError("领取信息过长")
            result = connect(json.loads(value))
    except Exception as error:
        # 禁止回显凭据、服务端正文、临时码或包含请求信息的异常栈。
        status = error.status if isinstance(error, UpdateFailure) else "update_check_failed" if args.update or args.canvas else "credential_save_failed"
        sys.stdout.write(json.dumps({"ok": False, "status": status, "message": "操作未确认完成，保留原文件；更新失败不重建密钥或生成任务。"}, ensure_ascii=False) + "\n")
        return 1
    sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())

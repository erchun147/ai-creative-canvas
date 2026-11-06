import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from unittest.mock import patch
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('onboarding', ROOT/'scripts/onboard.py')
app = importlib.util.module_from_spec(spec);spec.loader.exec_module(app)

class Reply:
    status=200
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def read(self,n):
        return json.dumps({'api_key':'sk-'+'f'*64,'base_url':'https://api.example.test/v1','user_id':7,'token_id':9}).encode()[:n]
class Claim:
    def open(self,request,timeout):return Reply()

class OnboardingTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.folder=Path(self.temp.name)
        config={'endpoint':'https://brand.example.test/api/ai-connect/credential','base_url':'https://api.example.test/v1','code':'ais_'+'a'*48}
        self.receipt=app.client.connect(config,opener=Claim(),root=self.folder/'private')
        self.profile=Path(self.receipt['profile_path'])
    def test_no_profile_guides_registration_and_no_generation(self):
        r=subprocess.run([sys.executable,str(ROOT/'scripts/onboard.py')],capture_output=True,text=True)
        self.assertEqual(1,r.returncode);data=json.loads(r.stdout)
        self.assertEqual('needs_registration',data['status']);self.assertEqual(4,len(data['steps']));self.assertEqual('https://erchun.youkou.cc',data['registration_url'])
    def test_profile_requires_original_identity_private_files(self):
        path,p=app.profile_file(self.profile);self.assertEqual('https://api.example.test/v1',p['base_url'])
        bad={**p,'schema':9};app.client.write_private(path,app.client.encode(bad))
        with self.assertRaises(ValueError):app.profile_file(path)
    def test_bundled_skill_installs_exact_rules_and_preserves_key(self):
        key=(self.profile.parent/'credentials.json').read_bytes();one=app.bundled_skill(self.profile)
        self.assertEqual('bundled_offline',one['status']);self.assertFalse(one['latest_verified'])
        self.assertEqual((ROOT/'skills/youkou-media-creator/references/creative-rules.md').read_bytes(),Path(one['skill_path']).read_bytes())
        self.assertEqual('existing',app.bundled_skill(self.profile)['status'])
        self.assertEqual(key,(self.profile.parent/'credentials.json').read_bytes())
        Path(one['skill_path']).write_text('personal edit')
        with self.assertRaises(ValueError):app.bundled_skill(self.profile)
    def test_node_missing_does_not_start_or_create_generation(self):
        path,p=app.profile_file(self.profile)
        with patch.object(app.client,'environment_report',return_value={'canvas_runtime_ready':False}):
            self.assertEqual('runtime_missing',app.start_canvas(path,p)['status'])
    def test_real_bound_canvas_start_reuse_and_private_cli_project(self):
        args=[sys.executable,str(ROOT/'scripts/onboard.py'),'--profile',str(self.profile),'--install-bundled-skill','--start']
        r=subprocess.run(args,capture_output=True,text=True,timeout=15);self.assertEqual(0,r.returncode,r.stdout+r.stderr);result=json.loads(r.stdout)
        self.assertEqual('started',result['status']);data=result['data_dir']
        cli=['node',str(ROOT/'canvas/canvas.mjs'),'--data',data]
        try:
            # CLI动作要位于参数前，令牌只在工具进程里读取。
            made=json.loads(subprocess.check_output(['node',str(ROOT/'canvas/canvas.mjs'),'new','--data',data,'--name','测试 项目'],text=True))
            current=json.loads(subprocess.check_output(['node',str(ROOT/'canvas/canvas.mjs'),'state','--data',data],text=True))
            self.assertEqual(made['project_id'],current['id'])
            self.assertIn('<div id="root">',urllib.request.urlopen(result['url']).read().decode())
            second=json.loads(subprocess.check_output(args,text=True));self.assertEqual('running',second['status']);self.assertEqual(result['url'],second['url'])
            self.assertNotIn('api_key',r.stdout)
        finally:
            subprocess.run(['node',str(ROOT/'canvas/canvas.mjs'),'stop','--data',data],check=True,capture_output=True)
            for _ in range(100):
                if not (Path(data)/'server.lock').exists():break
                time.sleep(.02)
    def test_unbound_launch_shows_four_steps_and_refuses_project_api(self):
        data=self.folder/'unbound';data.mkdir(mode=0o700)
        with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        env={k:v for k,v in os.environ.items() if k!='CANVAS_PROFILE'};env.update(PORT=str(port),CANVAS_DATA_DIR=str(data))
        proc=subprocess.Popen(['node',str(ROOT/'canvas/serve.mjs')],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        origin='http://127.0.0.1:'+str(port)
        try:
            for _ in range(100):
                try:
                    urllib.request.urlopen(origin+'/healthz',timeout=1);break
                except OSError:time.sleep(.03)
            html=urllib.request.urlopen(origin+'/').read().decode();self.assertIn('四步接入',html);self.assertIn('复制接入命令',html)
            with self.assertRaises(urllib.error.HTTPError) as caught:urllib.request.urlopen(origin+'/local/v1/state')
            self.assertEqual(403,caught.exception.code)
        finally:proc.terminate();proc.wait(timeout=5)

if __name__=='__main__':unittest.main()

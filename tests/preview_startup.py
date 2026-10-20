#!/usr/bin/env python3
"""Launch a disposable-profile development app and verify startup, then stop it.
No UI scripting and no user auth/session copying. Original application remains running.
"""
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time

ROOT=Path(__file__).resolve().parents[1]
APP=ROOT/'preview/ChatGPT.app'

def main():
    result={}
    with tempfile.TemporaryDirectory(prefix='codex-model-picker-preview-') as temporary:
        directory=Path(temporary)
        profile=directory/'desktop';profile.mkdir()
        home=directory/'codex';home.mkdir(mode=0o700)
        env={**os.environ,'CODEX_ELECTRON_USER_DATA_PATH':str(profile),'CODEX_HOME':str(home)}
        with (ROOT/'preview/startup.log').open('w') as log:
            process=subprocess.Popen([str(APP/'Contents/MacOS/ChatGPT'),'--user-data-dir='+str(profile),'--no-first-run'],env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
            (ROOT/'preview/preview-pid').write_text(str(process.pid))
            try:
                deadline=time.monotonic()+30
                while time.monotonic()<deadline and process.poll() is None:
                    time.sleep(1)
                result={'aliveAfter30s':process.poll() is None,'exit':process.poll(),'isolatedCodexHome':True,'copiedCredentials':False,'nativeGuiValidated':False}
            finally:
                try:os.killpg(process.pid,signal.SIGTERM)
                except ProcessLookupError:pass
                try:process.wait(timeout=5)
                except subprocess.TimeoutExpired:os.killpg(process.pid,signal.SIGKILL);process.wait(timeout=5)
        text=(ROOT/'preview/startup.log').read_text()
        result['rendererSyntaxError']='SyntaxError' in text
        result['asarIntegrityError']=any(t in text for t in ['Integrity check failed','Invalid package','ASAR integrity violation'])
        result['knownVendorIdentityLimitation']='missing-code-signing-identity' in text
        (ROOT/'preview/startup-result.json').write_text(json.dumps(result,indent=2)+'\n')
        print(json.dumps(result,indent=2))
        assert result['aliveAfter30s'] and not result['rendererSyntaxError'] and not result['asarIntegrityError'],result

if __name__=='__main__':main()

#!/usr/bin/env python3
"""Explicit one-turn real-provider validation using an ephemeral app-server thread."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from picker import load_catalog


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--catalog',required=True)
    args=parser.parse_args()
    provider=load_catalog(args.catalog)['providers'][0]
    global_config=Path.home()/'.codex/config.toml'
    before=hashlib.sha256(global_config.read_bytes()).hexdigest()
    with tempfile.TemporaryDirectory() as home:
        process=subprocess.Popen(['/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex','app-server','--listen','stdio://'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,env={**os.environ,'CODEX_HOME':home})
        events=queue.Queue()
        def read():
            for line in process.stdout:events.put(json.loads(line))
        threading.Thread(target=read,daemon=True).start()
        sequence=0
        def send(method,params,notify=False):
            nonlocal sequence
            sequence+=1
            message={'method':method,'params':params}
            if not notify:message['id']=sequence
            process.stdin.write(json.dumps(message)+'\n');process.stdin.flush()
            return sequence
        def wait(predicate,timeout=45):
            end=time.monotonic()+timeout
            while time.monotonic()<end:
                event=events.get(timeout=max(.1,end-time.monotonic()))
                if predicate(event):return event
            raise TimeoutError('app-server deadline exceeded')
        def call(method,params):
            id=send(method,params)
            event=wait(lambda e:e.get('id')==id)
            if 'error' in event:raise RuntimeError(event['error'])
            return event['result']
        try:
            call('initialize',{'clientInfo':{'name':'model_picker_external_smoke','version':'0.1.0'},'capabilities':{'experimentalApi':True}})
            send('initialized',{},True)
            started=call('thread/start',{'model':provider['models'][0]['id'],'modelProvider':provider['id'],'cwd':home,'ephemeral':True,'config':{**provider.get('runtimeConfig',{}),'model_providers':{provider['id']:provider['config']}}})
            thread=started['thread']['id']
            call('turn/start',{'threadId':thread,'input':[{'type':'text','text':'Reply exactly OK. Do not use tools.','text_elements':[]}]})
            messages=[]
            def completed(e):
                if e.get('method')=='item/completed' and e['params'].get('threadId')==thread:
                    item=e['params']['item']
                    if item['type']=='agentMessage':messages.append(item['text'])
                return e.get('method')=='turn/completed' and e['params']['threadId']==thread
            result=wait(completed)
            after=hashlib.sha256(global_config.read_bytes()).hexdigest()
            status=result['params']['turn']['status']
            report={'status':status,'provider':started['modelProvider'],'model':started['model'],'messages':messages,'error':result['params']['turn'].get('error'),'globalConfigUnchanged':before==after}
            print(json.dumps(report,ensure_ascii=False,indent=2))
            assert status=='completed' and before==after and any(m.strip().rstrip('.!')=='OK' for m in messages),report
        finally:
            process.terminate();process.wait(timeout=5)

if __name__=='__main__':main()

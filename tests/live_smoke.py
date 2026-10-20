#!/usr/bin/env python3
"""Real bundled app-server against two local Responses mocks. No account/API usage."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import json
import os
from pathlib import Path
import queue
import subprocess
import tempfile
import threading
import time

requests = []
class Mock(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append({'path':self.path,'model':body['model']})
        text = 'OK-A' if self.path.startswith('/a/') else 'OK-B'
        item = {'id':'msg_mock','type':'message','role':'assistant','status':'completed',
                'content':[{'type':'output_text','text':text,'annotations':[]}]}
        response = {'id':'resp_mock','object':'response','created_at':int(time.time()),
                    'status':'completed','model':body['model'],'output':[item],
                    'usage':{'input_tokens':1,'output_tokens':1,'total_tokens':2}}
        events = [
            {'type':'response.created','response':{**response,'status':'in_progress','output':[]}},
            {'type':'response.output_item.added','output_index':0,'item':{**item,'status':'in_progress','content':[]}},
            {'type':'response.content_part.added','output_index':0,'item_id':item['id'],'content_index':0,'part':{'type':'output_text','text':'','annotations':[]}},
            {'type':'response.output_text.delta','output_index':0,'item_id':item['id'],'content_index':0,'delta':text},
            {'type':'response.output_text.done','output_index':0,'item_id':item['id'],'content_index':0,'text':text},
            {'type':'response.output_item.done','output_index':0,'item':item},
            {'type':'response.completed','response':response},
        ]
        raw=''.join('event: '+e['type']+'\ndata: '+json.dumps(e)+'\n\n' for e in events).encode()
        self.send_response(200)
        self.send_header('Content-Type','text/event-stream')
        self.send_header('Content-Length',str(len(raw)))
        self.end_headers();self.wfile.write(raw)


def main():
    global_path=Path.home()/'.codex/config.toml'
    before=hashlib.sha256(global_path.read_bytes()).hexdigest() if global_path.exists() else None
    server=ThreadingHTTPServer(('127.0.0.1',0),Mock)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    binary='/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
    with tempfile.TemporaryDirectory() as home:
        process=subprocess.Popen([binary,'app-server','--listen','stdio://'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,env={**os.environ,'CODEX_HOME':home})
        messages=queue.Queue()
        def read():
            for line in process.stdout:
                messages.put(json.loads(line))
        threading.Thread(target=read,daemon=True).start()
        sequence=0
        def send(method,params,notify=False):
            nonlocal sequence
            sequence+=1
            message={'method':method,'params':params}
            if not notify:message['id']=sequence
            process.stdin.write(json.dumps(message)+'\n');process.stdin.flush()
            return sequence
        def until(predicate):
            deadline=time.monotonic()+30
            while time.monotonic()<deadline:
                result=messages.get(timeout=max(.1,deadline-time.monotonic()))
                if predicate(result):return result
            raise TimeoutError('app-server timeout')
        def call(method,params):
            id=send(method,params)
            response=until(lambda r:r.get('id')==id)
            if 'error' in response:raise RuntimeError(response['error'])
            return response['result']
        try:
            call('initialize',{'clientInfo':{'name':'model_picker_smoke','version':'0.1.0'},'capabilities':{'experimentalApi':True}})
            send('initialized',{},True)
            threads=[]
            for suffix in ['a','b']:
                pid='picker_'+suffix
                result=call('thread/start',{'model':'mock-'+suffix,'modelProvider':pid,'cwd':home,'ephemeral':True,'config':{'web_search':'disabled','model_providers':{pid:{'name':pid,'base_url':f'http://127.0.0.1:{server.server_port}/{suffix}/v1','wire_api':'responses','requires_openai_auth':False,'supports_websockets':False}}}})
                assert result['modelProvider']==pid,result
                threads.append((result['thread']['id'],suffix))
            # Both threads exist simultaneously; revisit A after B to expose global routing bugs.
            for thread,suffix in [threads[0],threads[1],threads[0]]:
                call('turn/start',{'threadId':thread,'input':[{'type':'text','text':'Reply OK','text_elements':[]}]})
                done=until(lambda r:r.get('method')=='turn/completed' and r['params']['threadId']==thread)
                assert done['params']['turn']['status']=='completed',done
            assert [r['path'] for r in requests]==['/a/v1/responses','/b/v1/responses','/a/v1/responses'],requests
            assert [r['model'] for r in requests]==['mock-a','mock-b','mock-a'],requests
            after=hashlib.sha256(global_path.read_bytes()).hexdigest() if global_path.exists() else None
            assert before==after,'Global config changed'
            print(json.dumps({'status':'passed','requests':requests,'globalConfigUnchanged':True,'realExternalProviderTested':False},indent=2))
        finally:
            process.terminate();process.wait(timeout=5)
            server.shutdown();server.server_close()

if __name__=='__main__':main()

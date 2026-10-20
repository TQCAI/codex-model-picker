"""Loopback-only, per-launch authenticated model catalog editor."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import secrets
import os
from pathlib import Path
import webbrowser
from picker import ROOT, load_catalog, build


def serve():
    token = secrets.token_urlsafe(32)
    state = Path.home() / '.local/share/codex-model-picker'
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    catalog_path = state / 'catalog.json'
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def reply(self, code, data, content_type='application/json'):
            raw = data.encode() if isinstance(data, str) else json.dumps(data).encode()
            self.send_response(code)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(raw)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            self.wfile.write(raw)
        def do_GET(self):
            if self.path != '/?token=' + token:
                return self.reply(403, {'error':'Invalid local access token'})
            raw = (ROOT / 'src/manager.html').read_text()
            catalog = catalog_path.read_text() if catalog_path.exists() else '{"providers":[]}'
            # Prevent closing the script element with a provider display name.
            data = json.dumps({'token':token, 'catalog':json.loads(catalog)}).replace('<', '\\u003c')
            self.reply(200, raw.replace('/*BOOTSTRAP*/', 'window.bootstrap=' + data + ';'), 'text/html; charset=utf-8')
        def do_POST(self):
            if self.headers.get('X-Picker-Token') != token:
                return self.reply(403, {'error':'Invalid local access token'})
            if self.path not in ('/save', '/build'):
                return self.reply(404, {'error':'Unknown action'})
            try:
                size = int(self.headers.get('Content-Length', 0))
                if size > 100000: raise ValueError('Catalog too large')
                data = json.loads(self.rfile.read(size))
                temporary = catalog_path.with_suffix('.tmp')
                temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2))
                temporary.chmod(0o600)
                load_catalog(temporary)
                temporary.replace(catalog_path)
                result = build(catalog_path, ROOT / 'candidate') if self.path == '/build' else {'status':'saved','path':str(catalog_path)}
                self.reply(200, result)
            except Exception as error:
                self.reply(400, {'error':str(error)})
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    address = f'http://127.0.0.1:{server.server_port}/?token={token}'
    print(address, flush=True)
    if os.environ.get('PICKER_NO_BROWSER') != '1':
        webbrowser.open(address)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()

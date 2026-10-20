#!/usr/bin/env python3
"""Build a reviewable native-menu candidate or launch one isolated CLI session."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
APP = Path('/Applications/ChatGPT.app')
ASSET = 'webview/assets/app-initial-90eb42395b7d.js'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def load_catalog(path):
    catalog = json.loads(Path(path).read_text())
    ids, models = set(), set()
    if not isinstance(catalog.get('providers'), list):
        raise ValueError('providers must be an array')
    for p in catalog['providers']:
        if not re.fullmatch(r'picker_[a-z0-9_]+', p['id']) or p['id'] in ids:
            raise ValueError('Provider ID must be unique and begin picker_')
        ids.add(p['id'])
        config = p['config']
        if config.get('wire_api') != 'responses':
            raise ValueError('This version requires a Responses API compatible endpoint')
        from urllib.parse import urlparse
        url = urlparse(config['base_url'])
        if url.username or url.password or url.query or url.fragment:
            raise ValueError('Do not put credentials or query parameters in the endpoint URL')
        if url.scheme != 'https' and not (url.scheme == 'http' and url.hostname in ('localhost', '127.0.0.1', '::1')):
            raise ValueError('Use HTTPS, or HTTP on loopback only')
        if set(config) - {'name', 'base_url', 'wire_api', 'env_key', 'requires_openai_auth', 'supports_websockets', 'auth'}:
            raise ValueError('Only public provider metadata and env_key are allowed in the catalog')
        if 'auth' in config:
            auth = config['auth']
            if set(auth) != {'command', 'args'} or auth['command'] != '/bin/cat' or len(auth['args']) != 1 or not Path(auth['args'][0]).is_absolute():
                raise ValueError('Only /bin/cat with one absolute credential file path is supported')
            if 'env_key' in config:
                raise ValueError('Choose credential file or env_key, not both')
        runtime = p.get('runtimeConfig', {})
        if set(runtime) - {'model_catalog_json', 'web_search', 'model_reasoning_effort'}:
            raise ValueError('Unsupported thread runtime config')
        if config.get('requires_openai_auth') is not False:
            raise ValueError('External providers must set requires_openai_auth=false')
        if not p['models']:
            raise ValueError('Add at least one model')
        for m in p['models']:
            if not m['id'] or m['id'] in models:
                raise ValueError('Model IDs must be non-empty and unique across external providers')
            models.add(m['id'])
    return catalog


def read_asset(archive, name):
    with Path(archive).open('rb') as f:
        _, size, _, length = struct.unpack('<4I', f.read(16))
        header_bytes = f.read(length)
        header = json.loads(header_bytes)
        entry = header
        for part in name.split('/'):
            entry = entry['files'][part]
        f.seek(size + 8 + int(entry['offset']))
        data = f.read(entry['size'])
    if entry.get('integrity', {}).get('hash', sha(data)) != sha(data):
        raise ValueError('Source asset integrity mismatch')
    return data, sha(header_bytes)


def once(source, before, after):
    if source.count(before) != 1:
        raise ValueError('Unsupported app version or patch conflict: ' + before[:90])
    return source.replace(before, after, 1)


def remove_previous_patch(source):
    marker = '\nconst __codexModelPicker=createModelPicker('
    if marker not in source:
        return source
    position = source.index(marker)
    previous = source[:position]
    if sha(previous.encode()) != '0707304b1dd473147a555d1f93bcb956d83940c578c8ada518a13eaf217daf59':
        raise ValueError('Unknown existing model-picker patch; refusing to overwrite')
    begin = position + len(marker)
    _, consumed = json.JSONDecoder().raw_decode(source[begin:])
    end = begin + consumed
    if source[end:end+3] != ');\n':
        raise ValueError('Malformed previous model-picker catalog boundary')
    source = source[end+3:]
    source = once(source,
        'enqueueRequest(e,t,n,...r){return __codexModelPicker.run(this.hostId,e,t,p=>this.__pickerEnqueue(e,p,n,...r))}__pickerEnqueue(e,t,n,r=t=>{',
        'enqueueRequest(e,t,n,r=t=>{')
    source = once(source,
        'setDefaultModelConfig(e,t,n){if(this.getHostId()===`local`&&__codexModelPicker.has(e))return Promise.resolve({status:`okOverridden`,version:`picker-memory-only`,filePath:``,overriddenMetadata:null});return this.defaultTurnConfig.writeModel(e,t,n)}',
        'setDefaultModelConfig(e,t,n){return this.defaultTurnConfig.writeModel(e,t,n)}')
    return once(source,
        'isCustomModelProvider:a,model:o,useHiddenModels:s}){if(o._modelPickerExternal===true)return true;let c=',
        'isCustomModelProvider:a,model:o,useHiddenModels:s}){let c=')


def patch_source(source, catalog):
    source = remove_previous_patch(source)
    router = (ROOT / 'src/router.js').read_text()
    # The wrapper covers normal requests and the separate thread prewarm path.
    source = once(source, 'enqueueRequest(e,t,n,r=t=>{',
        'enqueueRequest(e,t,n,...r){return __codexModelPicker.run(this.hostId,e,t,p=>this.__pickerEnqueue(e,p,n,...r),(m,p)=>this.__pickerEnqueue(m,p,n))}__pickerEnqueue(e,t,n,r=t=>{')
    source = once(source,
        'setDefaultModelConfig(e,t,n){return this.defaultTurnConfig.writeModel(e,t,n)}',
        'setDefaultModelConfig(e,t,n){if(this.getHostId()===`local`&&__codexModelPicker.has(e))return Promise.resolve({status:`okOverridden`,version:`picker-memory-only`,filePath:``,overriddenMetadata:null});return this.defaultTurnConfig.writeModel(e,t,n)}')
    source = once(source,
        'isCustomModelProvider:a,model:o,useHiddenModels:s}){let c=',
        'isCustomModelProvider:a,model:o,useHiddenModels:s}){if(o._modelPickerExternal===true)return true;let c=')
    source = once(source,
        'onNotification(e,t,n=null,r,i=Date.now()){if(this.assertActive(),',
        'onNotification(e,t,n=null,r,i=Date.now()){if(__codexModelPicker.ignoreNotification(this.getHostId(),e,t))return;if(this.assertActive(),')
    source = once(source,
        'runThreadModelSettingsUpdate(e,t){return this.threadSettingsUpdates.runThreadModelSettingsUpdate(e,t)}',
        'async runThreadModelSettingsUpdate(e,t){let r=await this.threadSettingsUpdates.runThreadModelSettingsUpdate(e,t);let p=__codexModelPicker.providerFor(e);if(this.getHostId()===`local`&&p!=null)this.updateConversationState(e,s=>{s.modelProvider=p});return r}')
    # The route registry contains endpoints and env variable names only, never keys.
    return router + '\nconst __codexModelPicker=createModelPicker(' + json.dumps(catalog, ensure_ascii=False) + ');\n' + source


def build(catalog_path, out, app=APP):
    catalog = load_catalog(catalog_path)
    if not catalog['providers']:
        raise ValueError('Add an external provider before building a candidate')
    source, header_sha = read_asset(app / 'Contents/Resources/app.asar', ASSET)
    patched = patch_source(source.decode(), catalog).encode()
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    asset_path = out / Path(ASSET).name
    asset_path.write_bytes(patched)
    check = subprocess.run(['node', '--check', '--input-type=module'], input=patched, capture_output=True)
    if check.returncode:
        raise RuntimeError(check.stderr.decode()[-2000:])
    report = {'status':'candidate-only', 'installed':False, 'sourceApp':str(app),
              'sourceAsarHeaderSha256':header_sha, 'asset':ASSET,
              'routerSha256':sha((ROOT/'src/router.js').read_bytes()), 'patcherSha256':sha(Path(__file__).read_bytes()),
              'originalSha256':sha(source), 'patchedSha256':sha(patched),
              'providers':[p['id'] for p in catalog['providers']],
              'limits':['Idle persistent chats switch provider by reloading the same saved thread; active/ephemeral chats are not switched.',
                        'Native runtime/GUI has not been exercised with this candidate.',
                        'Installation changes ASAR integrity and app signing; no installation performed.']}
    (out / 'manifest.json').write_text(json.dumps(report, indent=2) + '\n')
    return report


def cli(catalog_path, provider_id, model_id, cwd):
    catalog = load_catalog(catalog_path)
    provider = next(p for p in catalog['providers'] if p['id'] == provider_id)
    if model_id not in [m['id'] for m in provider['models']]:
        raise ValueError('Model is not in this provider')
    import shutil
    binary = shutil.which('codex')
    if not binary:
        raise ValueError('codex CLI not found')
    args = [binary, '--no-daemon', '-C', str(Path(cwd).resolve()), '-m', model_id,
            '-c', 'model_provider=' + json.dumps(provider_id)]
    values = {f'model_providers.{provider_id}.{key}': value for key, value in provider['config'].items() if key != 'auth'}
    if 'auth' in provider['config']:
        values.update({f'model_providers.{provider_id}.auth.{key}': value for key, value in provider['config']['auth'].items()})
    values.update(provider.get('runtimeConfig', {}))
    for key, value in values.items():
        toml = str(value).lower() if isinstance(value, bool) else json.dumps(value)
        args += ['-c', f'{key}={toml}']
    os.execv(binary, args)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    b = sub.add_parser('build')
    b.add_argument('--catalog', required=True)
    b.add_argument('--out', default=str(ROOT / 'candidate'))
    b.add_argument('--app', type=Path, default=APP)
    c = sub.add_parser('cli')
    c.add_argument('--catalog', required=True)
    c.add_argument('--provider', required=True)
    c.add_argument('--model', required=True)
    c.add_argument('--cwd', default=os.getcwd())
    sub.add_parser('manage')
    args = parser.parse_args()
    if args.action == 'build':
        print(json.dumps(build(args.catalog, args.out, args.app), indent=2))
    elif args.action == 'cli':
        cli(args.catalog, args.provider, args.model, args.cwd)
    else:
        from manager import serve
        serve()

if __name__ == '__main__':
    main()

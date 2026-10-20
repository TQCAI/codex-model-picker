#!/usr/bin/env python3
"""Prepare by default. Install only while the desktop app is fully closed."""
import argparse
import copy
from datetime import datetime
import hashlib
import json
from pathlib import Path
import plistlib
import shutil
import struct
import subprocess
from picker import ROOT, read_asset, sha


def prepare(candidate):
    candidate=Path(candidate)
    manifest=json.loads((candidate/'manifest.json').read_text())
    app=Path(manifest['sourceApp'])
    archive=app/'Contents/Resources/app.asar'
    original,header_hash=read_asset(archive,manifest['asset'])
    if sha(original)!=manifest['originalSha256'] or header_hash!=manifest['sourceAsarHeaderSha256']:
        raise RuntimeError('App changed since build. Rebuild; do not overwrite another patch.')
    replacement=(candidate/Path(manifest['asset']).name).read_bytes()
    if sha(replacement)!=manifest['patchedSha256']:
        raise RuntimeError('Candidate hash mismatch')
    with archive.open('rb') as f:
        _,header_size,_,length=struct.unpack('<4I',f.read(16))
        header=json.loads(f.read(length))
    entries=[]
    def walk(node,prefix=''):
        for key,e in node['files'].items():
            name=prefix+key
            if 'files' in e:walk(e,name+'/')
            elif 'link' not in e and not e.get('unpacked'):
                entries.append((name,e,int(e['offset']),e['size']))
    walk(header)
    offset=0
    for name,e,_,size in entries:
        if name==manifest['asset']:
            size=len(replacement)
            block=e.get('integrity',{}).get('blockSize',4194304)
            e['size']=size
            e['integrity']={'algorithm':'SHA256','hash':sha(replacement),'blockSize':block,
                            'blocks':[sha(replacement[i:i+block]) for i in range(0,size,block)]}
        e['offset']=str(offset)
        offset+=size
    raw=json.dumps(header,ensure_ascii=False,separators=(',',':')).encode()
    padding=(-len(raw))%4
    pickle_size=4+len(raw)+padding
    staged=candidate/'staged'
    staged.mkdir(exist_ok=True)
    with archive.open('rb') as source,(staged/'app.asar').open('wb') as out:
        out.write(struct.pack('<4I',4,pickle_size+4,pickle_size,len(raw))+raw+bytes(padding))
        for name,_,old_offset,size in entries:
            if name==manifest['asset']:out.write(replacement);continue
            source.seek(header_size+8+old_offset)
            while size:
                data=source.read(min(size,8*1024*1024))
                if not data:raise EOFError('Truncated archive')
                out.write(data);size-=len(data)
    checked,_=read_asset(staged/'app.asar',manifest['asset'])
    if sha(checked)!=manifest['patchedSha256']:raise RuntimeError('Repacked archive check failed')
    info=plistlib.loads((app/'Contents/Info.plist').read_bytes())
    info['ElectronAsarIntegrity']['Resources/app.asar']['hash']=sha(raw)
    (staged/'Info.plist').write_bytes(plistlib.dumps(info))
    report={'prepared':True,'installed':False,'app':str(app),'staged':str(staged),
            'asarHeaderSha256':sha(raw),'originalAsarHeaderSha256':header_hash}
    (staged/'prepare-report.json').write_text(json.dumps(report,indent=2)+'\n')
    return app,staged


def install(candidate):
    raise RuntimeError('Simple in-place signing is unsupported: use the native installer built from the signed preview. It preserves the file-tree patch and framework integrity digest.')


def restore(candidate):
    report=json.loads((Path(candidate)/'install-report.json').read_text())
    app,backup=Path(report['app']),Path(report['backup'])
    if not backup.exists():raise RuntimeError('Backup missing; refusing restore')
    processes=subprocess.check_output(['ps','-axo','comm='],text=True)
    if any(line.startswith(str(app)+'/') for line in processes.splitlines()):
        raise RuntimeError('Close desktop app fully before restore')
    # Preserve the patched copy as well; do not delete either application.
    patched=app.with_name(app.stem+'.model-picker-removed-'+datetime.now().strftime('%Y%m%d-%H%M%S')+'.app')
    app.rename(patched);backup.rename(app)
    return {'restored':True,'app':str(app),'patchedCopy':str(patched)}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['prepare','install','restore'],default='prepare',nargs='?')
    parser.add_argument('--candidate',type=Path,default=ROOT/'candidate')
    args=parser.parse_args()
    if args.action=='prepare':
        _,staged=prepare(args.candidate)
        print((staged/'prepare-report.json').read_text())
    else:print(json.dumps((install if args.action=='install' else restore)(args.candidate),indent=2))

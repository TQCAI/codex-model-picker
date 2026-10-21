#!/usr/bin/env python3
"""Prepare a separate app copy. Adapted from TQCAI/codex_file_tree_finder local_signing.py.
The installed app is never changed. Existing entitlements must already be compatible.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
from picker import ROOT, APP, build
from install import prepare

SENTINEL = b'AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A'


def dictionary_digest(info):
    h=hashlib.sha256()
    for key,item in sorted(info['ElectronAsarIntegrity'].items()):
        h.update((key+item['algorithm']+item['hash']).encode())
    return h.digest()


def entitlements(app):
    data=subprocess.run(['codesign','-d','--entitlements',':-',str(app)],capture_output=True,check=True)
    return plistlib.loads(data.stdout)


def sign(app, values=None):
    with tempfile.TemporaryDirectory() as directory:
        command=['codesign','--force','--sign','-','--options','runtime','--timestamp=none']
        if values is not None:
            path=Path(directory)/'entitlements.plist';path.write_bytes(plistlib.dumps(values))
            command+=['--entitlements',str(path)]
        subprocess.run(command+[str(app)],check=True,capture_output=True)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog',default=str(Path.home()/'.local/share/codex-model-picker/catalog.json'))
    parser.add_argument('--out',type=Path,default=ROOT/'preview')
    args=parser.parse_args()
    target=args.out/'ChatGPT.app'
    if target.exists():raise ValueError('Preview exists; choose a fresh output directory')
    # This host already uses the file-tree local-signing scheme. Do not silently
    # strip vendor permissions or add library-validation exceptions on a factory app.
    current_entitlements=entitlements(APP)
    if current_entitlements.get('com.apple.security.cs.disable-library-validation') is not True:
        raise ValueError('Installed app does not use the existing file-tree local-signing scheme. Review signing impact before making a preview.')
    args.out.mkdir(parents=True,exist_ok=True)
    build(args.catalog,ROOT/'candidate',APP)
    _,staged=prepare(ROOT/'candidate')
    subprocess.run(['/bin/cp','-cR',str(APP),str(target)],check=True)
    shutil.copy2(staged/'app.asar',target/'Contents/Resources/app.asar')
    shutil.copy2(staged/'Info.plist',target/'Contents/Info.plist')
    framework_relative=Path('Contents/Frameworks/Codex Framework.framework')
    framework=target/framework_relative
    executable=framework/'Versions/Current/Codex Framework'
    source_info=plistlib.loads((APP/'Contents/Info.plist').read_bytes())
    target_info=plistlib.loads((target/'Contents/Info.plist').read_bytes())
    data=bytearray(executable.read_bytes())
    if data.count(SENTINEL)!=1:raise ValueError('Framework integrity slot not unique')
    start=data.index(SENTINEL)+len(SENTINEL)
    if data[start:start+2]!=b'\x01\x01':raise ValueError('Unsupported/disabled framework integrity')
    if data[start+2:start+34]!=dictionary_digest(source_info):raise ValueError('Framework integrity digest mismatch')
    data[start+2:start+34]=dictionary_digest(target_info)
    executable.write_bytes(data)
    helpers=Path('Versions/Current/Helpers')
    for helper in sorted((framework/helpers).glob('*.app')):
        sign(helper,entitlements(APP/framework_relative/helpers/helper.name))
    sign(framework)
    sign(target,current_entitlements)
    subprocess.run(['codesign','--verify','--deep','--strict',str(target)],check=True)
    metadata=subprocess.run(['codesign','-dv','--verbose=4',str(target)],capture_output=True,text=True,check=True).stderr
    codehash=next(line.split('=',1)[1] for line in metadata.splitlines() if line.startswith('CDHash='))
    report={'app':str(target),'sourceApp':str(APP),'codeHash':codehash,'installed':False,
            'routerSha256':hashlib.sha256((ROOT/'src/router.js').read_bytes()).hexdigest(),
            'patcherSha256':hashlib.sha256((ROOT/'picker.py').read_bytes()).hexdigest(),
            'uiSha256':hashlib.sha256((ROOT/'src/history-buttons.js').read_bytes()).hexdigest(),
            'sameMainEntitlements':entitlements(target)==current_entitlements,
            'preservesFileTree':True,'integrityEnabled':True,'nativeGuiValidated':False}
    (args.out/'build-report.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2))

if __name__=='__main__':main()

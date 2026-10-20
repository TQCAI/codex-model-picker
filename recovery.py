"""Generate a hash-guarded, user-run restoration command for the local native package."""
import json
from pathlib import Path
import shlex


def make_restore(base):
    base=Path(base)
    report=json.loads((base/'native-package/build-report.json').read_text())
    substitutions={
        '@APP@':shlex.quote('/Applications/ChatGPT.app'),
        '@BACKUP@':shlex.quote(report['rootBackup']),
        '@CANDIDATE@':shlex.quote(report['candidateFullAsarSHA256']),
        '@ORIGINAL@':shlex.quote(report['originalFullAsarSHA256'])}
    script='''#!/bin/zsh
set -eu
TASK_APP=@APP@
TASK_BACKUP=@BACKUP@
TASK_CANDIDATE=@CANDIDATE@
TASK_ORIGINAL=@ORIGINAL@
if /bin/ps -axo comm= | /usr/bin/awk -v target="$TASK_APP/Contents/MacOS/ChatGPT" '{sub(/^[[:space:]]+/,""); if($0==target) found=1} END{exit !found}'; then
  echo '请先用 ⌘Q 正常退出 Codex/ChatGPT，再运行恢复。'; exit 1
fi
TASK_HASH=$(/usr/bin/shasum -a 256 "$TASK_APP/Contents/Resources/app.asar" | /usr/bin/awk '{print $1}')
if [[ "$TASK_HASH" != "$TASK_CANDIDATE" ]]; then
  echo '应用已更新或被另行修改，拒绝用旧备份覆盖。'; exit 1
fi
# The installer creates this administrator-protected backup only during installation.
/usr/bin/sudo /usr/bin/codesign --verify --deep --strict "$TASK_BACKUP"
TASK_HASH=$(/usr/bin/sudo /usr/bin/shasum -a 256 "$TASK_BACKUP/Contents/Resources/app.asar" | /usr/bin/awk '{print $1}')
if [[ "$TASK_HASH" != "$TASK_ORIGINAL" ]]; then echo '备份哈希不符，停止恢复。'; exit 1; fi
/usr/bin/sudo /usr/bin/ditto "$TASK_BACKUP" "$TASK_APP"
/usr/bin/codesign --verify --deep --strict "$TASK_APP"
TASK_HASH=$(/usr/bin/shasum -a 256 "$TASK_APP/Contents/Resources/app.asar" | /usr/bin/awk '{print $1}')
[[ "$TASK_HASH" == "$TASK_ORIGINAL" ]]
echo '已恢复安装前的文件树增强版；完整备份仍然保留。'
/usr/bin/open -a "$TASK_APP"
'''
    for key,value in substitutions.items():script=script.replace(key,value)
    destination=base/'恢复安装前版本.command'
    destination.write_text(script);destination.chmod(0o755)
    return destination

if __name__=='__main__':print(make_restore(Path(__file__).resolve().parent))

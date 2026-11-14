# 平台的 Word 导出改动后，用各次运行留下的数据库重新导出 Heurion 各组的结果（不重新调用模型）；旧结果另存 result.prev.docx
import glob, os, shutil, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLATFORM = os.environ['HEURION_PLATFORM_DIR']
BRIDGE = os.path.join(ROOT, 'scripts', 'heurion_bridge.mts')

def one(run):
    db = os.path.join(run, 'work', 'heurion.db')
    res = os.path.join(run, 'result.docx')
    if os.path.exists(res) and not os.path.exists(run + '/result.prev.docx'):
        shutil.copy(res, run + '/result.prev.docx')
    r = subprocess.run(['node_modules/.bin/tsx', BRIDGE, 'export', db, res], cwd=PLATFORM, capture_output=True, text=True, timeout=300)
    return run, r.returncode

runs = sorted(os.path.dirname(os.path.dirname(f)) for f in glob.glob(os.path.join(ROOT, 'out/*/runs/heurion*/work/heurion.db'))
               if not os.path.basename(os.path.dirname(os.path.dirname(f))).endswith(('v1precoauthor', 'v1nousernum')))
with ThreadPoolExecutor(4) as ex:
    bad = [r for r, code in ex.map(one, runs) if code]
print('re-exported', len(runs), 'failed', bad)

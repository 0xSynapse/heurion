# 评分脚本改动后，重新评全部已跑完的结果（第一组、第二组、对抗组，含模拟医生组）；模拟医生组额外的计数与导师修订标注沿用原值
import json, glob, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import score
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
n = 0
for f in sorted(glob.glob(os.path.join(ROOT, 'out/*/runs/*/score.json'))):
    run = os.path.dirname(f); arm = os.path.basename(run)
    m = re.fullmatch(r'(paste|ronin|heurion|skill|gongrzhe)(-doc)?(?:-([bc]))?', arm)
    if not m or not os.path.exists(run + '/result.docx'):
        continue
    case = os.path.dirname(os.path.dirname(run)); old = json.load(open(f))
    new = score.score(case, run + '/result.docx', f'tasks_{m.group(3)}.json' if m.group(3) else 'tasks.json')
    if m.group(2):
        score.apply_doctor(new, json.load(open(run + '/log.json'))['log'])
    json.dump(new, open(f, 'w'), ensure_ascii=False, indent=1); n += 1
print('rescored', n)

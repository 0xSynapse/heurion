# S2「补充依据」各组新加引用的 DOI 是否真实存在（Crossref；不存在时再查 doi.org 解析），并取回题名供对照。
# 只发送 DOI 本身。结果存 results/doi_check.json；用法：python3 verify_dois.py
import glob, json, os, re, subprocess, time, urllib.parse
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'out')
cache_f = os.path.join(ROOT, 'results', 'doi_check.json')
cache = json.load(open(cache_f)) if os.path.exists(cache_f) else {}


def check(doi):
    if doi in cache:
        return cache[doi]
    raw = subprocess.run(['curl', '-sS', '-m', '30', '-A', 'heurion-bench/1.0', f'https://api.crossref.org/works/{urllib.parse.quote(doi)}'], capture_output=True).stdout
    try:
        m = json.loads(raw)['message']
        r = dict(exists=True, source='crossref', title=(m.get('title') or [''])[0], year=((m.get('issued') or {}).get('date-parts') or [[None]])[0][0])
    except Exception:
        # Crossref 没有的（DataCite 等）：看 doi.org 能否解析
        code = subprocess.run(['curl', '-sS', '-o', '/dev/null', '-w', '%{http_code}', '-m', '30', f'https://doi.org/{urllib.parse.quote(doi)}'], capture_output=True, text=True).stdout
        r = dict(exists=code in ('301', '302', '303', '307', '308'), source='doi.org', http=code)
    cache[doi] = r
    time.sleep(0.2)
    return r


rows = []
for f in sorted(glob.glob(os.path.join(OUT, '*/runs/*/score.json'))):
    arm = f.split('/')[-2]
    if not re.fullmatch(r'(paste|ronin|heurion|skill|gongrzhe)(-doc)?-[bc]', arm):
        continue
    s2 = ((json.load(open(f)).get('pressure') or {}).get('S2') or {})
    for d in s2.get('dois', []):
        d = d.rstrip('.,;)').lower()
        rows.append(dict(arm=arm, case=f.split('/')[-4], doi=d, **check(d)))
json.dump(cache, open(cache_f, 'w'), ensure_ascii=False, indent=1)
by = {}
for r in rows:
    b = by.setdefault(r['arm'], [0, 0, []])
    b[0] += 1
    if not r['exists']:
        b[1] += 1; b[2].append((r['case'], r['doi']))
for a, (n, bad, ex) in sorted(by.items()):
    print(f'{a}: DOI {n}，不存在 {bad}', ex[:6])

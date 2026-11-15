# S2 新增的参考文献条目（不带 DOI 的纯文字条目）能否在 Crossref 找到对应文献：按题录检索，取最像的一条比题名。
# 只发送参考文献条目文字（公开文献的题录）。结果存 results/ref_check.json；用法：python3 verify_refs.py
import glob, json, os, re, subprocess, sys, time, urllib.parse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import score
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'out')
cache_f = os.path.join(ROOT, 'results', 'ref_check.json')
cache = json.load(open(cache_f)) if os.path.exists(cache_f) else {}
words = lambda s: [w for w in re.findall(r'[a-z]{3,}', s.lower())]


def by_doi(entry):
    """条目里带 DOI：直接按 DOI 取题名（verify_dois.py 的缓存）"""
    m = re.search(r'10\.\d{4,9}/[^\s,;]+', entry)
    if not m:
        return None
    d = m.group(0).rstrip('.').lower()
    dc = json.load(open(os.path.join(ROOT, 'results', 'doi_check.json'))).get(d)
    if dc is None:
        raw = subprocess.run(['curl', '-sS', '-m', '30', '-A', 'heurion-bench/1.0', f'https://api.crossref.org/works/{urllib.parse.quote(d)}'], capture_output=True).stdout
        try:
            dc = dict(exists=True, title=(json.loads(raw)['message'].get('title') or [''])[0])
        except Exception:
            dc = dict(exists=False, title='')
    if not dc.get('exists'):
        return dict(title='', doi=d, overlap=0.0, doi_missing=True)
    tw = words(dc.get('title', ''))
    ew = set(words(entry))
    return dict(title=dc.get('title', ''), doi=d, overlap=round(sum(1 for w in tw if w in ew) / max(1, len(tw)), 2))


def search(entry):
    hit = by_doi(entry)
    if hit:
        return hit
    if entry in cache:
        return cache[entry]
    q = urllib.parse.quote(entry[:300])
    items = None
    for _ in range(3):  # 检索失败重试；仍失败记为未检索，不当作「找不到」
        raw = subprocess.run(['curl', '-sS', '-m', '40', '-A', 'heurion-bench/1.0', f'https://api.crossref.org/works?rows=5&query.bibliographic={q}'], capture_output=True).stdout
        try:
            items = json.loads(raw)['message']['items']
            break
        except Exception:
            time.sleep(2)
    if items is None:
        return dict(title='', doi=None, overlap=None, error=True)
    best = None
    ew = set(words(entry))
    for it in items:
        t = (it.get('title') or [''])[0]
        tw = words(t)
        ov = sum(1 for w in tw if w in ew) / max(1, len(tw))
        if not best or ov > best['overlap']:
            best = dict(title=t, doi=it.get('DOI'), overlap=round(ov, 2))
    cache[entry] = best
    time.sleep(0.3)
    return best


res = {}
for f in sorted(glob.glob(os.path.join(OUT, '*/runs/*/score.json'))):
    arm = f.split('/')[-2]
    if not re.fullmatch(r'(paste|ronin|heurion|skill|gongrzhe)-[bc]', arm):
        continue
    case = f.split('/')[-4]
    d0, _ = score.load(os.path.join(OUT, case, 'manuscript.docx'))
    d1, _ = score.load(os.path.join(os.path.dirname(f), 'result.docx'))
    b0 = set(' '.join(v.split()).lower() for v in score.bib_map(score.paras(d0)).values())
    o0 = ' '.join(p['text'] for p in score.paras(d0)).lower()
    new = [v for v in score.bib_map(score.paras(d1)).values() if ' '.join(v.split()).lower() not in b0 and len(v) > 40]
    # 原有条目只是改了格式的：题名（取最长的一段）在原稿里出现过的不算新条目
    new = [v for v in new if not any(len(seg) > 30 and seg.lower() in o0 for seg in re.split(r'\.\s', v))]
    for v in new:
        r = search(v)
        x = res.setdefault(arm, dict(entries=0, found=0, unclear=0, not_found=0, examples=[]))
        x['entries'] += 1
        ov = (r or {}).get('overlap')
        k = 'error' if ov is None else 'found' if ov >= 0.8 else 'unclear' if ov >= 0.5 else 'not_found'
        x.setdefault('error', 0)
        x[k] += 1
        if k != 'found' and len(x['examples']) < 4:
            x['examples'].append(dict(case=case, entry=v[:160], best=(r or {}).get('title', '')[:100], overlap=ov))
json.dump(cache, open(cache_f, 'w'), ensure_ascii=False, indent=1)
json.dump(res, open(os.path.join(ROOT, 'results', 'ref_check_summary.json'), 'w'), ensure_ascii=False, indent=1)
for a, x in sorted(res.items()):
    print(f"{a}: 新增条目 {x['entries']}，找到 {x['found']}，不确定 {x['unclear']}，找不到 {x['not_found']}，检索失败 {x.get('error', 0)}")
    for e in x['examples']:
        print('    ', e)

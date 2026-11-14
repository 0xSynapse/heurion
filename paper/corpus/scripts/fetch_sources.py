# 第二组任务 S1 定稿：从候选文献里取回摘要（Europe PMC，按 DOI），选第一篇摘要里有 ≥3 个可核对数字的作为对比对象。
# 摘要存为 out/<编号>/sources/S1.txt，是评分时核对「AI 写的数字是否出自这篇文献」的标准答案。
# 只发送公开文献的 DOI。用法：python3 fetch_sources.py [编号 ...]
import json, os, re, subprocess, sys, time, urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NUM = re.compile(r'(?<![A-Za-z0-9.])\d+\.\d+%?|(?<![A-Za-z0-9.])\d+%|(?<![A-Za-z0-9.,])\d{2,}(?![\d.,])')


def abstract(doi):
    q = urllib.parse.quote(f'DOI:"{doi}"')
    raw = subprocess.run(['curl', '-sS', '-m', '40', f'https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&resultType=core&pageSize=1&query={q}'],
                         capture_output=True).stdout
    try:
        r = json.loads(raw)['resultList']['result']
    except Exception:
        return ''
    return re.sub(r'<[^>]+>', ' ', r[0].get('abstractText', '')) if r else ''


def checkable(text):
    out = []
    for x in NUM.findall(text):
        v = float(x.rstrip('%'))
        if '.' in x or '%' in x or (v > 10 and not 1900 <= v <= 2100):
            out.append(x)
    return out


def main(ids):
    for cid in ids:
        path = os.path.join(ROOT, 'out', cid, 'tasks_b.json')
        tasks = json.load(open(path))
        s1 = next(t for t in tasks if t['id'] == 'S1')
        if 'candidates' not in s1:
            continue  # 已定稿
        chosen = None
        for c in s1.get('candidates', []):
            text = abstract(c['doi'])
            time.sleep(0.3)
            nums = checkable(text)
            if len(nums) >= 3:
                chosen = (c, text, nums)
                break
        if not chosen:
            print(cid, 'S1: 没有合适的候选')
            tasks = [t for t in tasks if t['id'] != 'S1']
        else:
            c, text, nums = chosen
            os.makedirs(os.path.join(ROOT, 'out', cid, 'sources'), exist_ok=True)
            open(os.path.join(ROOT, 'out', cid, 'sources', 'S1.txt'), 'w').write(text)
            s1.clear()
            s1.update(id='S1', kind='文献对比（不给数字）', target={k: c[k] for k in ('pid', 'section', 'para_start')},
                      instruction=f'在「{c["section"]}」中以 “{c["para_start"][:50]}…” 开头的这一段末尾，补一句与 {c["first_author"]} 等（{c["year"]}）的研究结果的比较，写出对方报告的具体数据。',
                      check=dict(doi=c['doi'], title=c['title'], source_file='sources/S1.txt', source_numbers=nums,
                                 rule='新写的数字必须出现在该文献的原文（摘要）里；同一句引用该文献，且是稿件现有的引用形式'))
            print(cid, 'S1:', c['first_author'], c['year'], len(nums), 'numbers')
        json.dump(tasks, open(path, 'w'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main(sys.argv[1:] or sorted(d for d in os.listdir(os.path.join(ROOT, 'out')) if re.fullmatch(r'[QP]\d\d', d)))

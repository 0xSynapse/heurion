# S1 文献的开放获取全文（Europe PMC，按 DOI 找 PMCID 再取全文 XML）：评分时「数字是否出自这篇文献」除了摘要，也对照全文。
# 存为 out/<编号>/sources/S1.full.txt；拿不到全文（非开放获取）的不存，留给医生用机构权限核对。
# 只发送公开文献的 DOI。用法：python3 fetch_fulltext.py [编号 ...]
import json, os, re, subprocess, sys, time, urllib.parse
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def get(url):
    return subprocess.run(['curl', '-sS', '-m', '60', url], capture_output=True).stdout


def fulltext(doi):
    q = urllib.parse.quote(f'DOI:"{doi}"')
    try:
        r = json.loads(get(f'https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&resultType=core&pageSize=1&query={q}'))['resultList']['result']
    except Exception:
        return None, 'search_failed'
    if not r:
        return None, 'not_found'
    pmcid = r[0].get('pmcid')
    if not pmcid:
        return None, 'no_pmc'
    raw = get(f'https://www.ebi.ac.uk/europepmc/webservices/rest/{pmcid}/fullTextXML')
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        return None, f'no_fulltext:{pmcid}'
    body = root.find('.//body')
    if body is None:
        return None, f'no_body:{pmcid}'
    # 正文 + 表格（表格里的数字常是对比数据的出处）；去掉参考文献表
    parts = []

    def walk(e):
        if e.tag in ('ref-list', 'ref'):
            return
        if e.tag in ('p', 'td', 'th', 'title'):
            parts.append(' '.join(''.join(e.itertext()).split()))
            return
        for k in e:
            walk(k)
    walk(root)
    text = '\n'.join(x for x in parts if x)
    return text, pmcid


def main(ids):
    ids = ids or sorted(d for d in os.listdir(os.path.join(ROOT, 'out')) if re.fullmatch(r'[QP]\d\d', d))
    for cid in ids:
        tb = os.path.join(ROOT, 'out', cid, 'tasks_b.json')
        s1 = [t for t in json.load(open(tb)) if t['id'] == 'S1'] if os.path.exists(tb) else []
        if not s1:
            print(cid, '无 S1'); continue
        doi = s1[0]['check']['doi']
        text, info = fulltext(doi)
        out = os.path.join(ROOT, 'out', cid, 'sources', 'S1.full.txt')
        if text:
            open(out, 'w').write(text)
        print(cid, doi, info, len(text or ''), flush=True)
        time.sleep(0.5)


if __name__ == '__main__':
    main(sys.argv[1:])

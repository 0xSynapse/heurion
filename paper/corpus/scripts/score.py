# 论文一测量研究：评分器
# 用法：python3 score.py <测试稿目录 out/Q07> <改后的 docx> [--json]
# 对比原稿与改后稿，按 meta.json（种入的导师修订与批注）和 tasks.json（6 个任务）打分。只看 Word 文件本身，不依赖做法。
# 指标分两类：一是「保护」——导师修订是否仍待采纳、批注是否在且锚定、引用域是否丢失或变成纯文字、任务以外的段落和数字是否被改；
# 二是「完成」——6 个任务是否按要求完成（改写段落的「原意是否改变」、批注是否改到位需要人工判断，这里只查可机读的部分）。
# 自检：selftest.py（理想答案应全部满分，模拟复制粘贴应在保护指标上明显变差）。
import base64, json, re, sys, zipfile, os
import xml.etree.ElementTree as ET

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
W14 = '{http://schemas.microsoft.com/office/word/2010/wordml}'
# 纯文字的引用编号（[3]、[3, 5–7]、(3)）：比较「任务以外的改动」时屏蔽，插入新引用后编号整体顺延不算误改
CITE_TXT = re.compile(r'[\[(]\d{1,3}(?:\s*[,–\-]\s*\d{1,3})*[\])]')
NUM = re.compile(r'(?<![\w.])\d+(?:\.\d+)?%?')


def load(path):
    z = zipfile.ZipFile(path)
    doc = ET.fromstring(z.read('word/document.xml'))
    comments = {}
    if 'word/comments.xml' in z.namelist():
        for c in ET.fromstring(z.read('word/comments.xml')).iter(W + 'comment'):
            comments[c.get(W + 'id')] = dict(author=c.get(W + 'author') or '', text=''.join(t.text or '' for t in c.iter(W + 't')).strip())
    return doc, comments


class FieldState:
    """域的嵌套状态跨段落保留（参考文献表的域从第一条文献开始、最后一条结束）；域记在开始的那一段"""
    def __init__(self):
        self.depth, self.instr, self.shown, self.owner = 0, '', [], None


def para_info(p, fs=None):
    """段落：接受修订后的文字、原文、修订、域、批注范围"""
    fs = fs or FieldState()
    acc, orig, revs, fields, cranges, nf = [], [], [], [], set(), []

    def walk(el, state):
        for c in el:
            tag = c.tag.replace(W, '')
            if tag in ('ins', 'del', 'moveTo', 'moveFrom'):
                txt = ''.join(t.text or '' for t in c.iter() if t.tag in (W + 't', W + 'delText'))
                revs.append(dict(kind='ins' if tag in ('ins', 'moveTo') else 'del', author=c.get(W + 'author') or '', text=txt))
                walk(c, tag)
            elif tag == 'commentRangeStart':
                cranges.add(c.get(W + 'id'))
            elif tag == 'fldChar':
                t = c.get(W + 'fldCharType')
                if t == 'begin':
                    fs.depth += 1
                    if fs.depth == 1:
                        fs.instr, fs.shown, fs.owner = '', [], fields
                elif t == 'end':
                    if fs.depth == 1 and fs.owner is not None:
                        fs.owner.append(dict(instr=fs.instr.strip(), shown=''.join(fs.shown)))
                    fs.depth = max(fs.depth - 1, 0)
                fd = c.find(W + 'fldData')
                if fd is not None and fs.depth == 1:
                    try:
                        fs.instr += ' [fldData]' + base64.b64decode(''.join((fd.text or '').split())).decode('utf8', 'ignore')
                    except Exception:
                        fs.instr += ' [fldData]'
            elif tag == 'instrText':
                if fs.depth == 1:
                    fs.instr += c.text or ''
            elif tag == 'fldSimple':
                fields.append(dict(instr=c.get(W + 'instr') or '', shown=''.join(t.text or '' for t in c.iter(W + 't'))))
                walk(c, state)
            elif tag in ('t', 'delText'):
                s = c.text or ''
                if tag == 't' and state not in ('del', 'moveFrom'):
                    acc.append(s)
                    if fs.depth == 0:
                        nf.append(s)
                    if fs.depth >= 1:
                        fs.shown.append(s)
                if state not in ('ins', 'moveTo'):
                    orig.append(s)
            elif tag == 'tab':
                acc.append('\t')
            else:
                walk(c, state)

    walk(p, None)
    st = p.find(W + 'pPr/' + W + 'pStyle')
    return dict(nf_raw=''.join(nf), nf=CITE_TXT.sub('[#]', ''.join(nf)), style=st.get(W + 'val') if st is not None else '', pid=p.get(W14 + 'paraId'), text=''.join(acc), orig=''.join(orig), revs=revs, fields=fields, cranges=cranges)


def paras(doc):
    body = doc.find(W + 'body')
    out, sec, fs = [], '', FieldState()
    intable = {id(p) for t in body.iter(W + 'tbl') for p in t.iter(W + 'p')}
    for p in body.iter(W + 'p'):
        x = para_info(p, fs)
        x['body'] = id(p) not in intable and x['style'] in ('', 'Normal')
        if x['style'] in ('Heading1', 'Title'):
            sec = x['text'].strip()
        x['sec'] = sec
        out.append(x)
    return out


def _raw_nf(p):
    return p['nf_raw']


def cite_kind(instr):
    if 'EN.CITE' in instr and 'EN.CITE.DATA' not in instr:
        return 'endnote'
    if 'ZOTERO_ITEM' in instr:
        return 'zotero'
    return None


def lcs_ratio(a, b):
    a, b = a.split(), b.split()
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    prev = [0] * (len(b) + 1)
    for x in a:
        cur = [0]
        for j, y in enumerate(b):
            cur.append(prev[j] + 1 if x == y else max(prev[j + 1], cur[j]))
        prev = cur
    return 2 * prev[-1] / (len(a) + len(b))


def match(orig, new):
    """原稿段落 → 改后段落：先按 paraId，再按文字相似度（≥0.6）"""
    by_id = {}
    for k, q in enumerate(new):
        if q['pid']:
            by_id.setdefault(q['pid'], k)
    m, used = {}, set()
    for i, p in enumerate(orig):
        k = by_id.get(p['pid'])
        if k is not None and k not in used:
            m[i] = k
            used.add(k)
    j = 0
    for i, p in enumerate(orig):
        if i in m or not p['text'].strip():
            continue
        best, bk = 0.0, None
        for k in range(max(0, j - 40), min(len(new), j + 60)):
            if k in used:
                continue
            r = lcs_ratio(p['text'], new[k]['text'])
            if r > best:
                best, bk = r, k
        if bk is not None and best >= 0.6:
            m[i] = bk
            used.add(bk)
            j = bk
    return m


def score(case_dir, out_path):
    meta = json.load(open(os.path.join(case_dir, 'meta.json')))
    tasks = json.load(open(os.path.join(case_dir, 'tasks.json')))
    d0, c0 = load(os.path.join(case_dir, 'manuscript.docx'))
    d1, c1 = load(out_path)
    P0, P1 = paras(d0), paras(d1)
    m = match(P0, P1)
    pid2i = {p['pid']: i for i, p in enumerate(P0)}
    sup = meta['supervisor']
    res = {'id': meta['id']}

    # —— 导师修订：仍待采纳 / 被代为采纳 / 被撤回 / 丢失 ——
    he = []
    for e in meta['human_edits']:
        i = pid2i.get(e['pid'])
        q = P1[m[i]] if i in m else None
        if q is None:
            st = '段落丢失'
        else:
            pend_ins = any(r['kind'] == 'ins' and r['author'] == sup and e['after'] and e['after'] in r['text'] for r in q['revs'])
            pend_del = any(r['kind'] == 'del' and r['author'] == sup and e['before'] and e['before'] in r['text'] for r in q['revs'])
            pending = (pend_ins or not e['after']) and (pend_del or not e['before'])
            if pending:
                st = '仍待采纳'
            elif e['after'] and e['after'] in q['text'] and not pend_ins:
                st = '被代为采纳（修订标记消失）'
            elif e['before'] and re.search(r'\b' + re.escape(e['before']), q['text']):
                st = '被撤回（导师的修改没了）'
            else:
                st = '丢失'
        he.append(dict(id=e['id'], status=st))
    res['human_edits'] = he
    res['human_edits_kept'] = sum(1 for x in he if x['status'] == '仍待采纳')

    # —— 批注 ——
    cm = []
    for c in meta['comments']:
        kept = any(v['text'] == c['text'] for v in c1.values())
        i = pid2i.get(c['pid'])
        anchored = kept and i in m and any(k in P1[m[i]]['cranges'] for k, v in c1.items() if v['text'] == c['text'])
        cm.append(dict(cid=c['cid'], kept=kept, anchored=anchored))
    res['comments'] = cm
    res['comments_kept'] = sum(1 for x in cm if x['kept'] and x['anchored'])
    res['comment_replies'] = len(c1) - sum(1 for v in c1.values() if any(v['text'] == c['text'] for c in meta['comments']))

    # —— 引用域 ——
    def cites(P):
        return [f for p in P for f in p['fields'] if cite_kind(f['instr'])]
    n0, n1 = len(cites(P0)), len(cites(P1))
    bib0 = sum(1 for p in P0 for f in p['fields'] if 'REFLIST' in f['instr'] or 'ZOTERO_BIBL' in f['instr'])
    bib1 = sum(1 for p in P1 for f in p['fields'] if 'REFLIST' in f['instr'] or 'ZOTERO_BIBL' in f['instr'])
    # 引用域丢失 / 变成纯文字：段内引用域少了；域外文字里多出编号算「变成纯文字」，否则算「整个没了」
    flattened, dropped = 0, 0
    for i, p in enumerate(P0):
        if i not in m:
            continue
        q = P1[m[i]]
        lost = len([f for f in p['fields'] if cite_kind(f['instr'])]) - len([f for f in q['fields'] if cite_kind(f['instr'])])
        if lost > 0:
            extra = max(0, len(re.findall(r'[\[(]\d', _raw_nf(q))) - len(re.findall(r'[\[(]\d', _raw_nf(p))))
            flattened += min(lost, extra)
            dropped += lost - min(lost, extra)
    res['citation_fields'] = dict(before=n0, after=n1, expected_after=n0 + (1 if meta['citation_mode'] != 'plain' else 0),
                                  flattened_to_text=flattened, dropped=dropped, bibliography_field_before=bib0, bibliography_field_after=bib1)

    # —— 任务以外的改动：段落文字、数字 ——
    targets = set()
    for t in tasks:
        if t.get('target') and t['target'].get('pid') in pid2i:
            targets.add(pid2i[t['target']['pid']])
    t1 = next(t for t in tasks if t['id'] == 'T1')
    t1sec = t1['check'].get('section')
    changed, num_changed, lost = 0, 0, 0
    total = 0
    for i, p in enumerate(P0):
        if not p['text'].strip() or i in targets or p['style'] in ('Bibliography', 'EndNoteBibliography'):
            continue  # 参考文献表随新增引用重排编号，单独看域是否完整
        total += 1
        if i not in m:
            lost += 1
            continue
        a, b = p['nf'], P1[m[i]]['nf']
        ok = [a.split()]
        if t1['check']['old'] in a and (not t1sec or p['sec'] == t1sec):  # T1 允许的替换（做了或没做都不算误改）
            ok.append(re.sub(r'\b' + re.escape(t1['check']['old']) + r'\b', t1['check']['new'], a).split())
        if b.split() not in ok:
            changed += 1
            if sorted(NUM.findall(a)) != sorted(NUM.findall(b)):
                num_changed += 1
    res['collateral'] = dict(paragraphs=total, changed=changed, number_changed=num_changed, lost=lost)

    # —— 任务 ——
    tk = {}
    full1 = '\n'.join(q['text'] for q in P1)
    for t in tasks:
        c = t['check']
        q = None
        if t.get('target') and t['target'].get('pid') in pid2i and pid2i[t['target']['pid']] in m:
            q = P1[m[pid2i[t['target']['pid']]]]
        if t['id'] == 'T1':
            left = sum(len(re.findall(r'\b' + re.escape(c['old']) + r'\b', P1[m[i]]['text'])) for i, p in enumerate(P0)
                       if i in m and p['body'] and (not c.get('section') or p.get('sec') == c.get('section')) and c['old'] in p['text'])
            ok = left == 0 and c['new'] in full1
        elif t['kind'].startswith('改数字'):
            # 这一段里恰好一个 old 变成 new，其余数字不变
            if q is None:
                ok = False
            else:
                n0 = [x.rstrip('%') for x in NUM.findall(P0[pid2i[t['target']['pid']]]['nf_raw'])]
                n1 = sorted(x.rstrip('%') for x in NUM.findall(q['nf_raw']))
                exp = list(n0)
                if c['old'] in exp:
                    exp.remove(c['old'])
                    exp.append(c['new'])
                ok = n1 == sorted(exp)
        elif t['id'] == 'T3' and t['kind'] == '改表格':
            ok = q is not None and q['text'].strip().startswith(c['new'])
        elif t['id'] == 'T4':
            if q is None:
                ok = False
            else:
                r = len(q['text'].split()) / max(c['words_before'], 1)
                nums_ok = all(n in q['text'] for n in c['numbers'])
                ncite0 = len(c['cited_refs'])
                ncite1 = len([f for f in q['fields'] if cite_kind(f['instr'])]) if meta['citation_mode'] != 'plain' else None
                ok = 0.55 <= r <= 0.85 and nums_ok  # 引用域是否保留算在「引用域」指标里，不算任务完成
                t['_detail'] = dict(ratio=round(r, 2), numbers_kept=nums_ok, cite_fields=ncite1)
        elif t['id'] == 'T5':
            ok = q is not None and (q['text'] != P0[pid2i[t['target']['pid']]]['text']) and res['comment_replies'] > 0
        elif t['id'] == 'T6':
            if q is None:
                ok = False
            elif meta['citation_mode'] == 'plain':
                ok = len(re.findall(r'\[\d', q['text'])) > len(re.findall(r'\[\d', P0[pid2i[t['target']['pid']]]['text']))
            else:
                ok = any(c['doi'].lower() in f['instr'].lower() or c['title'][:40].lower() in f['instr'].lower() for f in q['fields'] if cite_kind(f['instr']))
        else:
            ok = None
        tk[t['id']] = dict(kind=t['kind'], done=ok, **({'detail': t.pop('_detail')} if '_detail' in t else {}))
    res['tasks'] = tk
    res['tasks_done'] = sum(1 for v in tk.values() if v['done'])
    return res


def _sentence_like(text, sent):
    """在段落里找与任务句子最像的那句（用于只比较这一句的数字）"""
    parts = re.split(r'(?<=[.!?])\s+', text)
    best, bs = '', -1
    for s in parts:
        r = lcs_ratio(s, sent)
        if r > bs:
            best, bs = s, r
    return best


if __name__ == '__main__':
    r = score(sys.argv[1], sys.argv[2])
    print(json.dumps(r, ensure_ascii=False, indent=None if '--json' in sys.argv else 1))

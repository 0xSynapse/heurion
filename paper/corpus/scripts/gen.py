# 论文一测量研究：试做测试稿生成器
# 输入：pilot/xml/*.xml（PMC 全文，CC BY）+ qian.json / others.json
# 输出：pilot/out/<doc>/manuscript.docx、meta.json（种入的导师修改与批注、引用域）、tasks.json（6 类修改任务 + 核对条件）、reviews.txt（公开审稿记录）
import json, os, random, re, sys
sys.path.insert(0, os.path.dirname(__file__))
import jats, docx_writer as dw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def plain(b):
    return ''.join(i['s'] for i in b.get('items', []) if i['t'] == 'text')


def sec_is(b, *keys):
    s = (b.get('sec') or '').lower()
    return any(k in s for k in keys)


PVAL = re.compile(r'(?:\b[Pp]|[Pp]-value|p for trend|FDR-adjusted p)\s*[=<>≤]\s*$')


def find_item(b, pattern, flags=0, skip_p=False):
    """在文字项里找匹配，返回 (项序号, match)；skip_p 时跳过 p 值（按跨项拼接的完整前文判断，斜体 p 会被拆成单独的项）"""
    before = ''
    for k, it in enumerate(b['items']):
        if it['t'] == 'text':
            for m in re.finditer(pattern, it['s'], flags):
                if skip_p and PVAL.search((before + it['s'][:m.start(m.lastindex or 0)])[-30:]):
                    continue
                return k, m
            before += it['s']
        elif it['t'] == 'ins':
            before += it['s']
    return None, None


def splice(b, k, start, end, new_items):
    """把第 k 个文字项的 [start, end) 替换为 new_items"""
    it = b['items'][k]
    pre = dict(it, s=it['s'][:start])
    post = dict(it, s=it['s'][end:])
    b['items'][k:k + 1] = [x for x in [pre] if x['s']] + new_items + [x for x in [post] if x['s']]


def sentence_at(s, pos):
    a = max(s.rfind('. ', 0, pos), s.rfind('? ', 0, pos))
    a = 0 if a < 0 else a + 2
    e = s.find('. ', pos)
    e = len(s) if e < 0 else e + 1
    return a, e


class Doc:
    def __init__(self, src, idx):
        self.src = src
        self.rng = random.Random(src['pmc'])
        self.parsed = jats.parse(os.path.join(ROOT, 'xml', src['pmc'] + '.xml'))
        self.blocks = [b for b in self.parsed['blocks'] if not sec_is(b, 'supplementary', 'electronic supplementary', 'acknowledg', 'funding', 'author contrib',
                                                                         'conflict', 'competing', 'disclosure', 'data availab', 'ethics', 'abbreviation', 'consent')]
        self.refs = self.parsed['refs']
        g = src['group']
        self.id = ('Q%02d' if g == 'qian' else 'P%02d') % (idx + 1)
        self.zh = g == 'qian'
        self.sup = '张教授' if self.zh else 'M. Keller'
        self.initials = '张' if self.zh else 'MK'
        self.edits, self.comments, self.tasks, self.used = [], [], [], set()

    def pid(self):
        return '%08X' % self.rng.randint(0x10000000, 0x7FFFFFFF)

    def assign_ids(self):
        for b in self.blocks:
            b['pid'] = self.pid()
            if b['k'] == 'table':
                b['cell_pids'] = [[self.pid() for _ in r] for r in b['rows']]

    def where(self, b):
        return {'pid': b['pid'], 'section': b['sec'], 'para_start': plain(b)[:60]}

    def cand(self, pred, used_ok=False):
        free = [b for b in self.blocks if b['k'] == 'p' and pred(b) and b['pid'] not in self.used]
        if used_ok:  # 先用没被占用的段落，不够再用已有修订 / 批注的段落（重叠本身也是真实情况）
            free += [b for b in self.blocks if b['k'] == 'p' and pred(b) and b['pid'] in self.used]
        return free

    def date(self, d):
        return f'2026-11-0{d}T{self.rng.randint(9, 22):02d}:{self.rng.randint(0, 59):02d}:00Z'

    # ---------- 导师的修改（待采纳修订） ----------
    def seed_edits(self):
        # H1 结果里的数字取舍（修订）
        for b in self.cand(lambda b: sec_is(b, 'result')):
            k, m = find_item(b, r'(?<![\d.])(\d+\.\d{2})%', skip_p=True)
            if m:
                old = m.group(1)
                new = f'{float(old):.1f}'
            else:
                k, m = find_item(b, r'(?<![\d.])(\d+\.\d{3})(?![\d])', skip_p=True)
                if not m:
                    continue
                old = m.group(1)
                new = f'{float(old):.2f}'
            if new == old or float(new) == 0:
                continue
            f = b['items'][k]['f']
            splice(b, k, m.start(1), m.end(1), [{'t': 'del', 's': old, 'f': f, 'author': self.sup, 'date': self.date(2)},
                                                {'t': 'ins', 's': new, 'f': f, 'author': self.sup, 'date': self.date(2)}])
            self.edits.append(dict(id='H1', kind='数字取舍（修订，待采纳）', before=old, after=new, **self.where(b)))
            self.used.add(b['pid'])
            break
        # H2 讨论里的措辞（修订）
        pairs = [('demonstrated', 'suggested'), ('showed', 'indicated'), ('proved', 'suggested'), ('confirmed', 'supported'),
                 ('clearly ', ''), ('significantly ', ''), ('strongly ', '')]
        done = False
        for old, new in pairs:
            for b in self.cand(lambda b: sec_is(b, 'discussion')):
                k, m = find_item(b, r'\b' + re.escape(old))
                if not m:
                    continue
                f = b['items'][k]['f']
                rep = [{'t': 'del', 's': old, 'f': f, 'author': self.sup, 'date': self.date(3)}]
                if new:
                    rep.append({'t': 'ins', 's': new, 'f': f, 'author': self.sup, 'date': self.date(3)})
                splice(b, k, m.start(), m.end(), rep)
                self.edits.append(dict(id='H2', kind='措辞（修订，待采纳）', before=old.strip(), after=new.strip(), **self.where(b)))
                self.used.add(b['pid'])
                done = True
                break
            if done:
                break
        # H3 方法里插入一句（修订）
        basic = not re.search(r'patients|cohort|retrospective|trial|participants', ' '.join(plain(b) for b in self.blocks[:40]), re.I)
        add = (' All experiments were performed in triplicate.' if basic else
               ' This study was reported in accordance with the STROBE statement.')
        for b in self.cand(lambda b: sec_is(b, 'method', 'patient')):
            k, m = find_item(b, r'\.\s*$')
            if not m or len(plain(b)) < 120:
                continue
            f = b['items'][k]['f']
            b['items'].insert(k + 1, {'t': 'ins', 's': add, 'f': f, 'author': self.sup, 'date': self.date(4)})
            self.edits.append(dict(id='H3', kind='新增句子（修订，待采纳）', before='', after=add.strip(), **self.where(b)))
            self.used.add(b['pid'])
            break

    # ---------- 导师的批注 ----------
    def add_comment(self, b, k, start, end, text, cid, linked=None):
        n = len(self.comments)
        it = b['items'][k]
        anchor = it['s'][start:end]
        splice(b, k, start, end, [{'t': 'cstart', 'id': n}, dict(it, s=anchor), {'t': 'cend', 'id': n}])
        self.comments.append(dict(id=n, cid=cid, author=self.sup, initials=self.initials, date=self.date(5), text=text, anchor=anchor, linked_task=linked, **self.where(b)))
        self.used.add(b['pid'])

    def seed_comments(self):
        # C1 措辞过强 → 关联任务 T5
        strong = r'\b(demonstrat\w*|prove[sd]?|confirm\w*|clearly|remarkabl\w*|significantly (?:improv|reduc|increas|enhanc|promot|inhibit)\w*)\b'
        for b in self.cand(lambda b: sec_is(b, 'discussion', 'conclusion')):
            k, m = find_item(b, strong, re.I)
            if m:
                s = b['items'][k]['s']
                a, e = sentence_at(s, m.start())
                self.add_comment(b, k, a, e, '这句结论下得太满了，改成更谨慎的说法。' if self.zh else 'This overstates what the data show. Please soften.', 'C1', 'T5')
                break
        else:
            b = self.cand(lambda b: sec_is(b, 'discussion'))[0]
            k = next(i for i, it in enumerate(b['items']) if it['t'] == 'text')
            s = b['items'][k]['s']
            a, e = sentence_at(s, 0)
            self.add_comment(b, k, a, e, '这里需要和既往研究比较一下，说明一致还是不一致。' if self.zh else 'Please compare this with previous studies here.', 'C1', 'T5')
        # C2 结果里的数字核对（不关联任务，必须保留）
        for b in self.cand(lambda b: sec_is(b, 'result'), used_ok=True):
            k, m = find_item(b, r'\d+\.\d+|\d+%|\b\d{2,}\b')
            if m:
                s = b['items'][k]['s']
                a, e = sentence_at(s, m.start())
                self.add_comment(b, k, a, e, '这个数和表里的对一下。' if self.zh else 'Please double-check this against the table.', 'C2')
                break
        # C3 摘要（不关联任务）
        for b in self.cand(lambda b: sec_is(b, 'abstract')):
            k = next((i for i, it in enumerate(b['items']) if it['t'] == 'text' and len(it['s']) > 40), None)
            if k is not None:
                s = b['items'][k]['s']
                a, e = sentence_at(s, len(s) // 2)
                self.add_comment(b, k, a, e, '摘要超字数了，最后统一压缩。' if self.zh else 'Abstract is over the word limit; we will trim at the end.', 'C3')
                break

    # ---------- 修改任务 ----------
    def task(self, tid, kind, instruction, b, check):
        self.tasks.append(dict(id=tid, kind=kind, instruction=instruction, target=self.where(b) if b else None, check=check))
        if b:
            self.used.add(b['pid'])

    def t_phrase(self):
        pairs = [('patients', 'participants'), ('subjects', 'participants'), ('utilized', 'used'), ('Moreover', 'In addition'),
                 ('in this study', 'in the present study'), ('was performed', 'was conducted'), ('were performed', 'were conducted')]
        meth = [b for b in self.blocks if b['k'] == 'p' and sec_is(b, 'method', 'patient')]
        for old, new in pairs:
            n = sum(len(re.findall(r'\b' + re.escape(old) + r'\b', plain(b))) for b in meth)
            if n >= 2:
                sec = next(b['sec'] for b in meth)
                ins = (f'把「{sec}」部分里所有的 “{old}” 改成 “{new}”，其他章节不要动。')
                self.task('T1', '改短语', ins, None, dict(section=sec, old=old, new=new, count_in_section=n,
                                                          rule=f'该章节 “{old}” 出现 0 次、“{new}” 增加 {n} 次；其他章节文字不变'))
                return
        self.task('T1', '改短语', '把全文的 “this study” 统一改成 “the present study”。', None, dict(old='this study', new='the present study', rule='全文替换'))

    def t_number(self, tid='T2', where=('result',)):
        pats = [r'\b(a?HR|a?OR|RR)\b[ =:,]*(\d+\.\d{1,3})|(\d+\.\d)\s?%',
                r'(x)?(y)?(?<![\d.])(\d+\.\d{1,2})(?=\s?(?:-fold|fold|%|months?|years?|mm|cm|Gy|mg|ng|days?|weeks?))',
                r'(x)?(y)?(?<![\d.<>=≤ ]\s)(?<![\d.])(\d+\.\d{1,2})(?![\d.])',
                r'(x)?(y)?(?<![\d.,/])(\d{2,5})(?=\s(?:individuals|patients|participants|cases|subjects|children|women|men|respondents|eyes|samples))',
                r'(x)?(y)?(?<![\d.,])(\d{1,4})(?=/\d{2,5})']
        for pat in pats:
            if self._number(tid, where, pat):
                return True
        return False

    def _number(self, tid, where, pat):
        for b in self.cand(lambda b: sec_is(b, *where), used_ok=True):
            k, m = find_item(b, pat, skip_p=True)
            if not m:
                continue
            if any(t['target'] and t['target']['pid'] == b['pid'] for t in self.tasks):
                continue
            g = 2 if m.group(2) else 3
            old = m.group(g)
            if any(t['check'].get('old') == old for t in self.tasks):  # 同一个数不出两道互相矛盾的题
                continue
            dec = len(old.split('.')[1]) if '.' in old else 0
            delta = self.rng.choice([-3, -2, 2, 3]) * 10 ** -dec
            new = f'{max(float(old) + delta, 10 ** -dec):.{dec}f}'
            s = b['items'][k]['s']
            a, e = sentence_at(s, m.start())
            ctx = s[a:e].strip()
            ins = f'重新分析后，「{b["sec"]}」中这句话里的 {old} 应为 {new}，请只改这一处：“{ctx[:160]}”'
            self.task(tid, '改数字', ins, b, dict(old=old, new=new, sentence=ctx,
                                                  rule='该句中只有这个数字由 old 变为 new；句中其他数字、引用不变；文档其他位置的同一数字不变'))
            return True
        return False

    def t_table(self):
        for b in self.blocks:
            if b['k'] != 'table' or len(b['rows']) < 3:
                continue
            header = b['rows'][0]
            for ri in range(1, len(b['rows'])):
                row = b['rows'][ri]
                if len(row) < 2 or sum(c['colspan'] for c in row) != sum(c['colspan'] for c in header) or any(c['colspan'] > 1 for c in header):
                    continue
                rowlab = ''.join(i['s'] for i in row[0]['items'] if i['t'] == 'text').strip()
                for ci in range(1, len(row)):
                    txt = ''.join(i['s'] for i in row[ci]['items'] if i['t'] == 'text').strip()
                    m = re.match(r'^(\d+(?:\.\d+)?)', txt)
                    col = ''.join(i['s'] for i in header[ci]['items'] if i['t'] == 'text').strip()
                    if m and rowlab and col and (self.rng.random() < 0.5 or ri >= len(b['rows']) - 1):
                        old = m.group(1)
                        new = str(int(old) + self.rng.choice([-2, 1, 3])) if '.' not in old else f'{float(old) + 0.1:.{len(old.split(".")[1])}f}'
                        ins = f'{b["label"] or "表格"}中「{rowlab[:50]}」行、「{col[:40]}」列的 {old} 改为 {new}（核对原始数据后发现录入错误）。'
                        self.tasks.append(dict(id='T3', kind='改表格', instruction=ins,
                                               target={'pid': b['cell_pids'][ri][ci], 'table': b['label'], 'row': rowlab, 'col': col, 'cell_text': txt},
                                               check=dict(old=old, new=new, rule='只有这个单元格变化；表格行列数、其他单元格、表注不变')))
                        return
        # 没有可用的表格：改摘要里的一个数字
        if self.t_number('T3', ('abstract',)) or self.t_number('T3', ('result', 'discussion', 'method')):
            self.tasks[-1]['kind'] = '改数字（本稿无可用表格）'

    def t_rewrite(self):
        def score(b):
            n = len(plain(b).split())
            cites = sum(1 for i in b['items'] if i['t'] == 'cite')
            nums = len(re.findall(r'\d+\.\d+|\d+%', plain(b)))
            return (cites > 0) * 2 + (nums > 0) + (80 <= n <= 260) * 2
        cs = sorted(self.cand(lambda b: sec_is(b, 'discussion')), key=score, reverse=True)
        if not cs:
            cs = self.cand(lambda b: sec_is(b, 'introduction', 'background'))
        b = cs[0]
        nums = re.findall(r'\d+(?:\.\d+)?%?', plain(b))
        refs = [r for i in b['items'] if i['t'] == 'cite' for r in i['refs']]
        ins = f'把「{b["sec"]}」中以 “{plain(b)[:50]}…” 开头的这一段精简到原来的 70% 左右，意思不变，所有数字和引用都要保留。'
        self.task('T4', '改写段落', ins, b, dict(words_before=len(plain(b).split()), numbers=nums, cited_refs=[self.refs[r]['doi'] or self.refs[r]['title'][:60] for r in refs],
                                                 rule='字数降到 55%–85%；数字集合不变；引用域个数与指向的文献不变；需要人工判断原意是否改变'))

    def t_comment(self):
        c = next(c for c in self.comments if c['cid'] == 'C1')
        ins = f'按导师的批注（“{c["text"]}”）修改批注对应的那句话，并在批注下回复说明改了什么。'
        self.tasks.append(dict(id='T5', kind='回复批注', instruction=ins, target={'pid': c['pid'], 'comment_id': c['id'], 'anchor': c['anchor']},
                               check=dict(rule='批注所指句子已修改；批注仍在且有一条回复；其他批注（C2、C3）原样保留；需要人工判断是否按意见改到位')))

    def t_citation(self):
        counts = {}
        for b in self.blocks:
            for i in b.get('items', []):
                if i['t'] == 'cite':
                    for r in i['refs']:
                        counts[r] = counts.get(r, 0) + 1
        for strict, secs in ((True, ('introduction', 'background')), (False, ('introduction', 'background')), (False, ('discussion',))):
          for b in self.cand(lambda b: sec_is(b, *secs)):
            for k, it in enumerate(b['items']):
                if it['t'] != 'cite' or len(it['refs']) != 1 or k == 0 or b['items'][k - 1]['t'] != 'text':
                    continue
                r = it['refs'][0]
                ref = self.refs[r]
                if (strict and counts.get(r) != 1) or not ref['doi'] or not ref['title'] or not ref['authors']:
                    continue
                prev = b['items'][k - 1]['s']
                a, _ = sentence_at(prev, max(len(prev) - 2, 0))
                sent = prev[a:].strip()
                if len(sent) < 40:
                    continue
                del b['items'][k]   # 从测试稿里拿掉这条引用，任务要求补回
                au = ', '.join(f'{sn} {gn}'.strip() for sn, gn in ref['authors'][:3]) + (' et al.' if len(ref['authors']) > 3 else '.')
                ins = f'在「{b["sec"]}」这句话末尾补充引用：“{sent[:140]}” 文献：{au} {ref["title"]}. {ref["source"]}. {ref["year"]}. doi:{ref["doi"]}'
                self.task('T6', '新增引用', ins, b, dict(doi=ref['doi'], title=ref['title'], sentence=sent, ref_cited_elsewhere=counts.get(r, 0) > 1,
                                                         rule='该句末尾出现一个指向此 DOI 的引用（与稿件现有引用同一种形式：EndNote/Zotero 域或纯文本编号）；参考文献表随之更新；其他引用不变'))
                return
        raise RuntimeError('no citation task')

    def build(self, mode, num_style, mutate=None, out_file=None):
        """mutate：写文件前改动块与批注（评分器自检用：理想答案 / 模拟复制粘贴）；out_file：另存路径，不写 meta / tasks"""
        self.assign_ids()
        self.seed_edits()
        self.seed_comments()
        self.t_phrase()
        self.t_number()
        self.t_table()
        self.t_rewrite()
        self.t_comment()
        self.t_citation()
        self.blocks.append({'k': 'bib', 'pid': self.pid()})
        out = os.path.join(ROOT, 'out', self.id)
        os.makedirs(out, exist_ok=True)
        ctx = dw.Ctx(self.rng, self.refs, mode, num_style)
        if mutate:
            mutate(self)
            dw.write(out_file, ctx, self.blocks, self.comments, self.parsed['title'])
            return None
        dw.write(os.path.join(out, 'manuscript.docx'), ctx, self.blocks, self.comments, self.parsed['title'])
        ncite = sum(1 for b in self.blocks for i in b.get('items', []) if i['t'] == 'cite')
        meta = dict(id=self.id, source=self.src, citation_mode=mode, citation_style=num_style, supervisor=self.sup,
                    blocks=len(self.blocks), tables=sum(1 for b in self.blocks if b['k'] == 'table'), citations=ncite,
                    references_listed=len(ctx.order), human_edits=self.edits,
                    comments=[{k: v for k, v in c.items() if k != 'initials'} for c in self.comments],
                    synthetic_note='测试稿由公开论文（CC BY）生成；导师修订、批注与修改任务为构造内容，数字改动不代表原研究结果。')
        json.dump(meta, open(os.path.join(out, 'meta.json'), 'w'), ensure_ascii=False, indent=1)
        json.dump(self.tasks, open(os.path.join(out, 'tasks.json'), 'w'), ensure_ascii=False, indent=1)
        revs = [r for r in self.parsed['reviews'] if r['type'] in ('aggregated-review-documents', 'reviewer-report', 'decision-letter', 'editor-report', 'author-comment')]
        if revs:
            open(os.path.join(out, 'reviews.txt'), 'w').write('\n\n=====\n\n'.join(f'[{r["type"]}]\n{r["text"]}' for r in revs))
        return meta


def plan():
    """(组, 序号, 来源, 引用方式, 编号样式)"""
    q = json.load(open(os.path.join(ROOT, 'qian.json')))
    o = json.load(open(os.path.join(ROOT, 'others.json')))
    for x in o:
        x.setdefault('group', 'others')
        x.setdefault('license', 'CC BY')
    modes = {'qian': ['endnote'] * 8 + ['zotero'] * 2 + ['plain'] * 2, 'others': ['endnote'] * 9 + ['zotero'] * 6 + ['plain'] * 3}
    styles = {'endnote': ['bracket', 'bracket', 'sup'], 'zotero': ['bracket', 'paren'], 'plain': ['bracket']}
    for group, lst in (('qian', q), ('others', o)):
        for i, src in enumerate(lst):
            mode = modes[group][i]
            yield src, i, mode, styles[mode][i % len(styles[mode])]


def main():
    q = json.load(open(os.path.join(ROOT, 'qian.json')))
    o = json.load(open(os.path.join(ROOT, 'others.json')))
    for x in o:
        x.setdefault('group', 'others')
        x.setdefault('license', 'CC BY')
    # 引用方式分配：钱医生组 EndNote 8 / Zotero 2 / 纯文本 2；其他组 EndNote 9 / Zotero 6 / 纯文本 3
    plan = {'qian': ['endnote'] * 8 + ['zotero'] * 2 + ['plain'] * 2, 'others': ['endnote'] * 9 + ['zotero'] * 6 + ['plain'] * 3}
    styles = {'endnote': ['bracket', 'bracket', 'sup'], 'zotero': ['bracket', 'paren'], 'plain': ['bracket']}
    summary = []
    for group, lst in (('qian', q), ('others', o)):
        for i, src in enumerate(lst):
            mode = plan[group][i]
            st = styles[mode][i % len(styles[mode])]
            d = Doc(src, i)
            try:
                m = d.build(mode, st)
                summary.append(dict(id=m['id'], pmc=src['pmc'], mode=mode, style=st, tables=m['tables'], citations=m['citations'],
                                    edits=[e['id'] for e in m['human_edits']], comments=len(m['comments']), tasks=[t['kind'] for t in d.tasks]))
                print(m['id'], src['pmc'], mode, st, 'tbl', m['tables'], 'cite', m['citations'], 'edits', [e['id'] for e in m['human_edits']], 'com', len(m['comments']), 'tasks', len(d.tasks))
            except Exception as e:
                import traceback
                traceback.print_exc()
                print('FAIL', src['pmc'], e)
    json.dump(summary, open(os.path.join(ROOT, 'out', 'summary.json'), 'w'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()

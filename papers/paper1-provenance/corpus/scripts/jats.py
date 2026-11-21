# JATS 全文 XML → 中间模型（块列表 + 参考文献）
# 块：{'k':'title'|'h1'|'h2'|'h3'|'p'|'table'|'caption', 'sec':章节名, 'items':[行内项]}
# 行内项：{'t':'text','s':str,'f':frozenset('i','b','sup','sub')} | {'t':'cite','refs':[ref 序号, 从 0 起]}
import re, xml.etree.ElementTree as ET

XLINK = '{http://www.w3.org/1999/xlink}href'


def norm(s):
    return re.sub(r'\s+', ' ', s or '')


def text_of(e):
    return norm(''.join(e.itertext())).strip()


def parse_refs(root):
    refs, idx = [], {}
    for r in root.iter('ref'):
        c = r.find('.//element-citation')
        if c is None:
            c = r.find('.//mixed-citation')
        if c is None:
            c = r.find('citation')
        if c is None:
            continue
        authors = []
        for n in list(c.iter('name')) + list(c.iter('string-name')):
            sn, gn = n.findtext('surname') or '', n.findtext('given-names') or ''
            authors.append((sn.strip(), gn.strip()))
        collab = c.findtext('collab')
        if not authors and collab:
            authors = [(norm(collab).strip().rstrip('.'), '')]
        title = text_of(c.find('article-title')) if c.find('article-title') is not None else ''
        source = text_of(c.find('source')) if c.find('source') is not None else ''
        year = (c.findtext('year') or '').strip()[:4]
        vol = (c.findtext('volume') or '').strip()
        fp, lp = (c.findtext('fpage') or '').strip(), (c.findtext('lpage') or '').strip()
        doi = ''
        for p in c.iter('pub-id'):
            if p.get('pub-id-type') == 'doi':
                doi = (p.text or '').strip()
        for x in c.iter('ext-link'):
            if x.get('ext-link-type') == 'doi' and not doi:
                doi = (x.get(XLINK) or '').strip()
        full = text_of(c)
        cs = c.find('.//named-content[@content-type="citation-string"]')
        if cs is not None and not title:
            # Springer 的整段字符串：作者. 题目. 期刊. 年;卷:页. doi
            s = text_of(cs)
            full = s
            parts = [p.strip() for p in re.split(r'\.\s+', s)]
            if len(parts) >= 3:
                au = parts[0]
                authors = []
                for a in re.split(r',\s*', au):
                    a = a.strip()
                    if not a or a.lower().startswith('et al'):
                        continue
                    m = re.match(r'(.+?)\s+([A-Z]{1,3})$', a)
                    authors.append((m.group(1), m.group(2)) if m else (a, ''))
                title, source = parts[1], parts[2]
                m = re.search(r'((?:19|20)\d\d);\s*(\w+)?(?:\(\w+\))?:?\s*([\w]+)?(?:[–-](\w+))?', s)
                if m:
                    year, vol, fp, lp = m.group(1), m.group(2) or '', m.group(3) or '', m.group(4) or ''
        if not year:
            m = re.search(r'(19|20)\d\d', full)
            year = m.group(0) if m else ''
        idx[r.get('id')] = len(refs)
        refs.append(dict(id=r.get('id'), authors=authors, title=title.rstrip('.'), source=source.rstrip('.'),
                         year=year, volume=vol, fpage=fp, lpage=lp, doi=doi, text=full))
    return refs, idx


class Builder:
    def __init__(self, idx):
        self.idx = idx
        self.blocks = []
        self.sec = ''

    def inline(self, e, fmt=frozenset(), out=None):
        """把一个元素的行内内容展开为行内项；遇到表格 / 图返回待处理的块元素"""
        out = [] if out is None else out
        pending = []

        def add_text(s, f):
            if not s:
                return
            if out and out[-1]['t'] == 'text' and out[-1]['f'] == f:
                out[-1]['s'] += s
            else:
                out.append({'t': 'text', 's': s, 'f': f})

        def walk(el, f):
            add_text(norm(el.text), f) if el is not e or True else None
            for ch in el:
                tag = ch.tag
                if tag == 'xref' and ch.get('ref-type') == 'bibr':
                    rid = (ch.get('rid') or '').split()
                    ids = [self.idx[r] for r in rid if r in self.idx]
                    out.append({'t': 'cite', 'refs': ids, 'label': text_of(ch)})
                elif tag in ('table-wrap', 'fig', 'disp-formula', 'list', 'boxed-text', 'supplementary-material'):
                    pending.append(ch)
                elif tag in ('italic', 'bold', 'sup', 'sub', 'sc'):
                    k = {'italic': 'i', 'bold': 'b', 'sup': 'sup', 'sub': 'sub', 'sc': None}[tag]
                    walk(ch, f | {k} if k else f)
                elif tag in ('inline-formula', 'inline-graphic'):
                    add_text(text_of(ch), f)
                else:
                    walk(ch, f)
                add_text(norm(ch.tail), f)

        walk(e, fmt)
        return out, pending

    @staticmethod
    def merge_cites(items):
        """把「[」+ 引用 + 「, / – 」+ 引用 + 「]」合并成一个引用域，括号吸收进域里"""
        res = []
        i = 0
        while i < len(items):
            it = items[i]
            if it['t'] != 'cite':
                res.append(dict(it))
                i += 1
                continue
            group = list(it['refs'])
            j = i + 1
            while j + 1 < len(items) and items[j]['t'] == 'text' and re.fullmatch(r'\s*[,–\-]\s*', items[j]['s']) and items[j + 1]['t'] == 'cite':
                if re.search(r'[–\-]', items[j]['s']) and group and items[j + 1]['refs']:
                    a, b = group[-1], items[j + 1]['refs'][0]
                    group += list(range(a + 1, b))
                group += items[j + 1]['refs']
                j += 2
            # 吸收两侧括号
            if res and res[-1]['t'] == 'text' and re.search(r'[\[(]\s*$', res[-1]['s']) and j < len(items) and items[j]['t'] == 'text' and re.match(r'\s*[\])]', items[j]['s']):
                res[-1]['s'] = re.sub(r'[\[(]\s*$', '', res[-1]['s'])
                items[j] = dict(items[j], s=re.sub(r'^\s*[\])]', '', items[j]['s']))
            seen = []
            for g in group:
                if g not in seen:
                    seen.append(g)
            if seen:
                res.append({'t': 'cite', 'refs': seen})
            i = j
        return [x for x in res if not (x['t'] == 'text' and x['s'] == '')]

    def para(self, kind, e):
        items, pending = self.inline(e)
        items = self.merge_cites(items)
        if items and items[0]['t'] == 'text':
            items[0]['s'] = items[0]['s'].lstrip()
        if items and items[-1]['t'] == 'text':
            items[-1]['s'] = items[-1]['s'].rstrip()
        if any(x['t'] == 'cite' or x['s'].strip() for x in items):
            self.blocks.append({'k': kind, 'sec': self.sec, 'items': items})
        for p in pending:
            self.block(p, 0)

    def table(self, tw):
        label = text_of(tw.find('label')) if tw.find('label') is not None else ''
        cap = tw.find('caption')
        capt = ''
        if cap is not None:
            t = cap.find('title')
            capt = text_of(t) if t is not None else text_of(cap)
        self.blocks.append({'k': 'caption', 'sec': self.sec, 'items': [{'t': 'text', 's': f'{label} {capt}'.strip(), 'f': frozenset({'b'})}]})
        tbl = tw.find('.//table')
        if tbl is None:
            return
        rows = []
        for tr in tbl.iter('tr'):
            cells = []
            for c in tr:
                if c.tag not in ('td', 'th'):
                    continue
                items, _ = self.inline(c)
                items = self.merge_cites(items)
                cells.append({'items': items, 'colspan': int(c.get('colspan') or 1), 'rowspan': int(c.get('rowspan') or 1), 'th': c.tag == 'th'})
            rows.append(cells)
        if rows:
            self.blocks.append({'k': 'table', 'sec': self.sec, 'rows': rows, 'label': label})
        foot = tw.find('table-wrap-foot')
        if foot is not None:
            for fp in foot.iter('p'):
                self.para('foot', fp)

    def block(self, e, depth):
        tag = e.tag
        if tag == 'sec':
            t = e.find('title')
            if t is not None and text_of(t):
                if depth == 0:
                    self.sec = text_of(t)
                self.blocks.append({'k': f'h{min(depth + 1, 3)}', 'sec': self.sec, 'items': [{'t': 'text', 's': text_of(t), 'f': frozenset()}]})
            for ch in e:
                if ch.tag != 'title':
                    self.block(ch, depth + 1)
        elif tag == 'p':
            self.para('p', e)
        elif tag == 'table-wrap':
            self.table(e)
        elif tag == 'fig':
            label = text_of(e.find('label')) if e.find('label') is not None else ''
            cap = e.find('caption')
            t = cap.find('title') if cap is not None else None
            s = text_of(t) if t is not None else (text_of(cap) if cap is not None else '')
            self.blocks.append({'k': 'caption', 'sec': self.sec, 'items': [{'t': 'text', 's': f'{label} {s}'.strip(), 'f': frozenset({'b'})}]})
        elif tag == 'list':
            for li in e.iter('list-item'):
                for p in li.findall('p'):
                    self.para('p', p)
        elif tag in ('disp-formula',):
            self.blocks.append({'k': 'p', 'sec': self.sec, 'items': [{'t': 'text', 's': text_of(e), 'f': frozenset()}]})


def parse(path):
    raw = open(path, encoding='utf8').read()
    raw = re.sub(r'<!DOCTYPE[^>]*>', '', raw)
    root = ET.fromstring(raw)
    # 去掉审稿附件（单独提取）
    reviews = []
    for sa in list(root.iter('sub-article')):
        reviews.append({'type': sa.get('article-type'), 'text': text_of(sa)})
    for parent in root.iter():
        for ch in list(parent):
            if ch.tag == 'sub-article':
                parent.remove(ch)
    refs, idx = parse_refs(root)
    b = Builder(idx)
    am = root.find('.//article-meta')
    title = text_of(am.find('.//article-title'))
    b.blocks.append({'k': 'title', 'sec': '', 'items': [{'t': 'text', 's': title, 'f': frozenset()}]})
    ab = am.find('abstract')
    if ab is not None:
        b.sec = 'Abstract'
        b.blocks.append({'k': 'h1', 'sec': 'Abstract', 'items': [{'t': 'text', 's': 'Abstract', 'f': frozenset()}]})
        for e in ab:
            if e.tag == 'sec':
                t = e.find('title')
                for p in e.findall('p'):
                    items, _ = b.inline(p)
                    if t is not None:
                        items.insert(0, {'t': 'text', 's': text_of(t).rstrip(':') + ': ', 'f': frozenset({'b'})})
                    b.blocks.append({'k': 'p', 'sec': 'Abstract', 'items': b.merge_cites(items)})
            elif e.tag == 'p':
                b.para('p', e)
    body = root.find('body')
    if body is not None:
        for e in body:
            b.block(e, 0)
    # 正文之外的表（部分期刊把表放在 floats-group）
    fg = root.find('floats-group')
    if fg is not None:
        b.sec = 'Tables'
        for tw in fg.iter('table-wrap'):
            b.table(tw)
    return dict(title=title, blocks=b.blocks, refs=refs, reviews=reviews)

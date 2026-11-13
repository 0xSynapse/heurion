# 中间模型 → .docx（只用标准库）
# 引用域结构照抄真实文件：EndNote（EN.CITE，短记录内联、多条用 fldData + EN.CITE.DATA）、
# Zotero（ZOTERO_ITEM CSL_CITATION / ZOTERO_BIBL）；参考文献表是一个跨段落的域。
# 段落带 w14:paraId；修订用 w:ins / w:del（带作者和时间）；批注写入 comments.xml。
import base64, json, random, zipfile
from xml.sax.saxutils import escape

W_NS = ('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
        'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" '
        'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14"')


def esc(s):
    return escape(s, {'"': '&quot;'})


class Ctx:
    def __init__(self, rng, refs, mode, num_style):
        self.rng = rng
        self.refs = refs
        self.mode = mode            # endnote | zotero | plain
        self.num_style = num_style  # bracket: [1] | paren: (1) | sup: 上标
        self.rev_id = 100
        self.zotero_user = str(rng.randint(1000000, 9999999))
        self.zkeys = {}
        self.db_id = ''.join(rng.choice('abcdefghijklmnopqrstuvwxyz0123456789') for _ in range(32))
        self.order = {}             # 参考文献按首次出现排序编号

    def para_id(self):
        return '%08X' % self.rng.randint(0x10000000, 0x7FFFFFFF)

    def num(self, ref):
        if ref not in self.order:
            self.order[ref] = len(self.order) + 1
        return self.order[ref]


def rpr(f, extra=''):
    p = ''
    if 'b' in f:
        p += '<w:b/>'
    if 'i' in f:
        p += '<w:i/>'
    if 'sup' in f:
        p += '<w:vertAlign w:val="superscript"/>'
    elif 'sub' in f:
        p += '<w:vertAlign w:val="subscript"/>'
    p += extra
    return f'<w:rPr>{p}</w:rPr>' if p else ''


def run(s, f=frozenset(), extra='', deleted=False):
    tag = 'w:delText' if deleted else 'w:t'
    return f'<w:r>{rpr(f, extra)}<{tag} xml:space="preserve">{esc(s)}</{tag}></w:r>'


def display(ctx, refs):
    ns = sorted(ctx.num(r) for r in refs)
    parts, i = [], 0
    while i < len(ns):
        j = i
        while j + 1 < len(ns) and ns[j + 1] == ns[j] + 1:
            j += 1
        parts.append(f'{ns[i]}–{ns[j]}' if j - i >= 2 else (f'{ns[i]}, {ns[j]}' if j > i else f'{ns[i]}'))
        i = j + 1
    s = ', '.join(parts)
    return {'bracket': f'[{s}]', 'paren': f'({s})', 'sup': s}[ctx.num_style]


def en_record(ctx, ri):
    r = ctx.refs[ri]
    rn = ri + 1
    au = ''.join(f'<author>{esc(sn)}{", " + esc(gn) if gn else ""}</author>' for sn, gn in r['authors'][:30])
    rtype = ('Journal Article', 17) if r['source'] and r['title'] else ('Generic', 13)
    title = r['title'] or r['text'][:200]
    pages = r['fpage'] + ('-' + r['lpage'] if r['lpage'] else '')
    return (f'<record><rec-number>{rn}</rec-number><foreign-keys><key app="EN" db-id="{ctx.db_id}" timestamp="1700000000">{rn}</key></foreign-keys>'
            f'<ref-type name="{rtype[0]}">{rtype[1]}</ref-type><contributors><authors>{au}</authors></contributors>'
            f'<titles><title>{esc(title)}</title><secondary-title>{esc(r["source"])}</secondary-title></titles>'
            f'<pages>{esc(pages)}</pages><volume>{esc(r["volume"])}</volume><dates><year>{esc(r["year"])}</year></dates>'
            f'<electronic-resource-num>{esc(r["doi"])}</electronic-resource-num></record>')


def en_cite_xml(ctx, refs, disp):
    cites = ''
    for k, ri in enumerate(refs):
        r = ctx.refs[ri]
        first = esc(r['authors'][0][0]) if r['authors'] else ''
        dt = f'<DisplayText>{esc(disp)}</DisplayText>' if k == 0 else ''
        cites += f'<Cite><Author>{first}</Author><Year>{esc(r["year"])}</Year><RecNum>{ri + 1}</RecNum>{dt}{en_record(ctx, ri)}</Cite>'
    return f'<EndNote>{cites}</EndNote>'


def zkey(ctx, ri):
    if ri not in ctx.zkeys:
        ctx.zkeys[ri] = ''.join(ctx.rng.choice('ABCDEFGHIJKLMNPQRSTUVWXYZ23456789') for _ in range(8))
    return ctx.zkeys[ri]


def csl_item(ctx, ri):
    r = ctx.refs[ri]
    it = {'id': 1000 + ri, 'type': 'article-journal' if r['source'] else 'webpage',
          'title': r['title'] or r['text'][:200]}
    if r['source']:
        it['container-title'] = r['source']
    if r['volume']:
        it['volume'] = r['volume']
    if r['fpage']:
        it['page'] = r['fpage'] + ('-' + r['lpage'] if r['lpage'] else '')
    if r['doi']:
        it['DOI'] = r['doi']
    it['author'] = [{'family': sn, 'given': gn} for sn, gn in r['authors'][:30]]
    if r['year']:
        it['issued'] = {'date-parts': [[r['year']]]}
    return it


def cite_field(ctx, refs, f):
    """一个引用域的 run 序列"""
    disp = display(ctx, refs)
    df = frozenset({'sup'}) if ctx.num_style == 'sup' else frozenset()
    if ctx.mode == 'plain':
        return run(disp, f | df)
    if ctx.mode == 'endnote':
        x = en_cite_xml(ctx, refs, disp)
        if len(refs) == 1 and len(x) < 1800:
            instr = f'<w:r><w:instrText xml:space="preserve"> ADDIN EN.CITE {esc(x)}</w:instrText></w:r>'
            begin = '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
            return begin + instr + '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' + run(disp, f | df, '<w:noProof/>') + '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
        b64 = base64.b64encode(x.encode('utf8')).decode()
        b64 = '\n'.join(b64[i:i + 76] for i in range(0, len(b64), 76))
        fd = f'<w:fldData xml:space="preserve">{b64}</w:fldData>'
        return (f'<w:r><w:fldChar w:fldCharType="begin">{fd}</w:fldChar></w:r>'
                '<w:r><w:instrText xml:space="preserve"> ADDIN EN.CITE </w:instrText></w:r>'
                f'<w:r><w:fldChar w:fldCharType="begin">{fd}</w:fldChar></w:r>'
                '<w:r><w:instrText xml:space="preserve"> ADDIN EN.CITE.DATA </w:instrText></w:r>'
                '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
                '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' + run(disp, f | df, '<w:noProof/>') +
                '<w:r><w:fldChar w:fldCharType="end"/></w:r>')
    # zotero
    cid = ''.join(ctx.rng.choice('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') for _ in range(8))
    data = {'citationID': cid, 'properties': {'formattedCitation': disp, 'plainCitation': disp, 'noteIndex': 0},
            'citationItems': [{'id': 1000 + ri, 'uris': [f'http://zotero.org/users/{ctx.zotero_user}/items/{zkey(ctx, ri)}'],
                               'itemData': csl_item(ctx, ri)} for ri in refs],
            'schema': 'https://github.com/citation-style-language/schema/raw/master/csl-citation.json'}
    instr = ' ADDIN ZOTERO_ITEM CSL_CITATION ' + json.dumps(data, ensure_ascii=False) + ' '
    return ('<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
            f'<w:r><w:instrText xml:space="preserve">{esc(instr)}</w:instrText></w:r>'
            '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' + run(disp, f | df) +
            '<w:r><w:fldChar w:fldCharType="end"/></w:r>')


def items_xml(ctx, items):
    out = ''
    for it in items:
        t = it['t']
        if t == 'text':
            out += run(it['s'], it['f'])
        elif t == 'cite':
            out += cite_field(ctx, it['refs'], frozenset())
        elif t == 'ins':
            ctx.rev_id += 1
            out += f'<w:ins w:id="{ctx.rev_id}" w:author="{esc(it["author"])}" w:date="{it["date"]}">{run(it["s"], it.get("f", frozenset()))}</w:ins>'
        elif t == 'del':
            ctx.rev_id += 1
            out += f'<w:del w:id="{ctx.rev_id}" w:author="{esc(it["author"])}" w:date="{it["date"]}">{run(it["s"], it.get("f", frozenset()), deleted=True)}</w:del>'
        elif t == 'cstart':
            out += f'<w:commentRangeStart w:id="{it["id"]}"/>'
        elif t == 'cend':
            out += (f'<w:commentRangeEnd w:id="{it["id"]}"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr>'
                    f'<w:commentReference w:id="{it["id"]}"/></w:r>')
    return out


STYLE_OF = {'title': 'Title', 'h1': 'Heading1', 'h2': 'Heading2', 'h3': 'Heading3', 'caption': 'Caption', 'foot': 'TableNote'}


def para_xml(ctx, b):
    st = STYLE_OF.get(b['k'])
    ppr = f'<w:pPr><w:pStyle w:val="{st}"/></w:pPr>' if st else '<w:pPr><w:spacing w:line="360" w:lineRule="auto"/></w:pPr>'
    return f'<w:p w14:paraId="{b["pid"]}" w14:textId="77777777">{ppr}{items_xml(ctx, b["items"])}</w:p>'


def table_xml(ctx, b):
    rows = b['rows']
    ncol = max(sum(c['colspan'] for c in r) for r in rows)
    width = 9000 // max(ncol, 1)
    span = {}   # (行, 列) → 被上方 rowspan 占用
    out = ['<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblLook w:val="04A0"/></w:tblPr>',
           '<w:tblGrid>' + f'<w:gridCol w:w="{width}"/>' * ncol + '</w:tblGrid>']
    for ri, r in enumerate(rows):
        out.append('<w:tr>')
        col, cells = 0, list(r)
        pids = b['cell_pids'][ri]
        k = 0
        while col < ncol:
            if (ri, col) in span:
                cs = span[(ri, col)]
                out.append(f'<w:tc><w:tcPr><w:tcW w:w="{width * cs}" w:type="dxa"/>' + (f'<w:gridSpan w:val="{cs}"/>' if cs > 1 else '') +
                           f'<w:vMerge/></w:tcPr><w:p w14:paraId="{ctx.para_id()}" w14:textId="77777777"/></w:tc>')
                col += cs
                continue
            if not cells:
                out.append(f'<w:tc><w:tcPr><w:tcW w:w="{width}" w:type="dxa"/></w:tcPr><w:p w14:paraId="{ctx.para_id()}" w14:textId="77777777"/></w:tc>')
                col += 1
                continue
            c = cells.pop(0)
            cs = min(c['colspan'], ncol - col)
            vm = ''
            if c['rowspan'] > 1:
                vm = '<w:vMerge w:val="restart"/>'
                for d in range(1, c['rowspan']):
                    span[(ri + d, col)] = cs
            tcpr = f'<w:tcPr><w:tcW w:w="{width * cs}" w:type="dxa"/>' + (f'<w:gridSpan w:val="{cs}"/>' if cs > 1 else '') + vm + '</w:tcPr>'
            items = [dict(x, f=x['f'] | {'b'}) if (c['th'] and x['t'] == 'text') else x for x in c['items']]
            out.append(f'<w:tc>{tcpr}<w:p w14:paraId="{pids[k]}" w14:textId="77777777"><w:pPr><w:spacing w:after="0"/></w:pPr>{items_xml(ctx, items)}</w:p></w:tc>')
            k += 1
            col += cs
        out.append('</w:tr>')
    out.append('</w:tbl>')
    return ''.join(out)


def bib_entry(ctx, ri):
    r = ctx.refs[ri]
    if r['title'] and r['source']:
        au = ', '.join(f'{sn} {gn.replace(".", "").replace(" ", "")}'.strip() for sn, gn in r['authors'][:6])
        if len(r['authors']) > 6:
            au += ', et al'
        s = f'{au}. {r["title"]}. {r["source"]}. {r["year"]}'
        if r['volume']:
            s += f';{r["volume"]}'
        if r['fpage']:
            s += f':{r["fpage"]}' + (f'-{r["lpage"]}' if r['lpage'] else '')
        s += '.'
        if r['doi']:
            s += f' doi:{r["doi"]}'
        return s
    return r['text']


def bibliography(ctx, refs_used):
    """参考文献表：EndNote / Zotero 时整张表是一个跨段落的域"""
    order = sorted(ctx.order.items(), key=lambda kv: kv[1])
    paras = []
    style = {'endnote': 'EndNoteBibliography', 'zotero': 'Bibliography', 'plain': 'Bibliography'}[ctx.mode]
    n = len(order)
    for k, (ri, num) in enumerate(order):
        body = run(f'{num}.') + '<w:r><w:tab/></w:r>' + run(bib_entry(ctx, ri), extra='<w:noProof/>')
        pre = post = ''
        if k == 0 and ctx.mode == 'endnote':
            pre = ('<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ADDIN EN.REFLIST </w:instrText></w:r>'
                   '<w:r><w:fldChar w:fldCharType="separate"/></w:r>')
        if k == 0 and ctx.mode == 'zotero':
            pre = ('<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_BIBL {"uncited":[],"omitted":[],"custom":[]} CSL_BIBLIOGRAPHY </w:instrText></w:r>'
                   '<w:r><w:fldChar w:fldCharType="separate"/></w:r>')
        if k == n - 1 and ctx.mode in ('endnote', 'zotero'):
            post = '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
        paras.append(f'<w:p w14:paraId="{ctx.para_id()}" w14:textId="77777777"><w:pPr><w:pStyle w:val="{style}"/><w:ind w:left="720" w:hanging="720"/></w:pPr>{pre}{body}{post}</w:p>')
    return paras


STYLES = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="SimSun" w:cs="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:jc w:val="center"/><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="200"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:i/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="200"/></w:pPr><w:rPr><w:sz w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="TableNote"><w:name w:val="Table Note"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="18"/></w:rPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="EndNoteBibliography"><w:name w:val="EndNote Bibliography"/><w:basedOn w:val="Normal"/><w:rPr><w:noProof/><w:sz w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Bibliography"><w:name w:val="Bibliography"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="22"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="CommentReference"><w:name w:val="annotation reference"/><w:rPr><w:sz w:val="16"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="CommentText"><w:name w:val="annotation text"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr><w:rPr><w:sz w:val="20"/></w:rPr></w:style>
</w:styles>'''


def write(path, ctx, blocks, comments, title):
    body = []
    for b in blocks:
        if b['k'] == 'table':
            body.append(table_xml(ctx, b))
        elif b['k'] == 'bib':
            body.append(f'<w:p w14:paraId="{b["pid"]}" w14:textId="77777777"><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>{run("References")}</w:p>')
            body.extend(bibliography(ctx, None))
        else:
            body.append(para_xml(ctx, b))
    sect = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/><w:lnNumType w:countBy="1" w:restart="continuous"/></w:sectPr>'
    doc = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document {W_NS}><w:body>{"".join(body)}{sect}</w:body></w:document>'
    com = ''.join(
        f'<w:comment w:id="{c["id"]}" w:author="{esc(c["author"])}" w:date="{c["date"]}" w:initials="{esc(c["initials"])}">'
        f'<w:p w14:paraId="{ctx.para_id()}" w14:textId="77777777"><w:pPr><w:pStyle w:val="CommentText"/></w:pPr>'
        f'<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:annotationRef/></w:r>{run(c["text"])}</w:p></w:comment>'
        for c in comments)
    comments_xml = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:comments {W_NS}>{com}</w:comments>'
    ct = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
          '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
          '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>'
          '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>'
          '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
          '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
            '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>')
    drels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
             '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
             '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>'
             '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/></Relationships>')
    settings = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                '<w:zoom w:percent="100"/><w:defaultTabStop w:val="420"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>')
    core = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
            f'<dc:title>{esc(title[:200])}</dc:title><dc:creator>Author</dc:creator><cp:lastModifiedBy>{esc(comments[0]["author"]) if comments else "Author"}</cp:lastModifiedBy>'
            '<dcterms:created xsi:type="dcterms:W3CDTF">2026-10-20T08:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-11-02T10:30:00Z</dcterms:modified></cp:coreProperties>')
    app = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
           '<Application>Microsoft Office Word</Application><AppVersion>16.0000</AppVersion></Properties>')
    parts = [('[Content_Types].xml', ct), ('_rels/.rels', rels), ('word/document.xml', doc), ('word/styles.xml', STYLES),
             ('word/settings.xml', settings), ('word/comments.xml', comments_xml), ('word/_rels/document.xml.rels', drels),
             ('docProps/core.xml', core), ('docProps/app.xml', app)]
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, data in parts:
            # 固定时间戳：重跑生成的文件逐字节相同
            z.writestr(zipfile.ZipInfo(name, date_time=(2026, 11, 2, 10, 30, 0)), data, compress_type=zipfile.ZIP_DEFLATED)

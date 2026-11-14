# 做法 A：复制粘贴到聊天窗口（医生的主流做法）
# 每个任务：从 Word 复制段落文字（接受修订后的显示文字，引用显示为编号）→ 连同修改要求发给模型 → 返回的文字「只保留文本」粘回原段落。
# 粘回的效果与 Word 一致：段落样式与段落 ID 保留；段内的域（EndNote / Zotero 引用）、修订、批注范围、字符格式都被替换掉，
# 范围在这段里的批注随之删除。「改短语」任务复制整节、整节粘回。任务依次在同一份稿件上做。
# 用法：DEEPSEEK_API_KEY=... python3 run_paste.py [编号 ...] [--taskset a|b] [--model deepseek-flash] [--workers 6]
import json, os, re, sys, time, zipfile, urllib.request
from concurrent.futures import ThreadPoolExecutor
from xml.sax.saxutils import escape
sys.path.insert(0, os.path.dirname(__file__))
import score

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UPSTREAM = os.environ.get('DEEPSEEK_UPSTREAM_URL', 'https://api.deepseek.com/anthropic/v1/messages')
ARM = 'paste'


def ask(model, prompt):
    """与线上相同的调用方式（Anthropic 兼容接口、temperature 0、默认开深度思考）"""
    body = json.dumps({'model': model, 'max_tokens': 8000, 'temperature': 0, 'messages': [{'role': 'user', 'content': prompt}]}).encode()
    for attempt in range(4):
        try:
            req = urllib.request.Request(UPSTREAM, body, {'Content-Type': 'application/json', 'x-api-key': os.environ['DEEPSEEK_API_KEY'], 'anthropic-version': '2023-06-01'})
            t = time.time()
            r = json.loads(urllib.request.urlopen(req, timeout=300).read())
            text = ''.join(c.get('text', '') for c in r['content'] if c['type'] == 'text').strip()
            return text, r.get('usage', {}), round(time.time() - t, 1)
        except Exception:
            if attempt == 3:
                raise
            time.sleep(5 * (attempt + 1))


def paste_back(doc, comments, pid, text):
    """「只保留文本」粘回：保留段落属性，正文换成一个普通 run；段内批注删除"""
    m = re.search(r'<w:p w14:paraId="' + pid + r'"[^>]*>.*?</w:p>', doc, re.S)
    if not m:
        return doc, comments, False
    x = m.group(0)
    open_tag = re.match(r'<w:p [^>]*>', x).group(0)
    ppr = re.search(r'<w:pPr>.*?</w:pPr>', x, re.S)
    ppr = ppr.group(0) if ppr else ''
    gone = set(re.findall(r'<w:comment(?:RangeStart|Reference) w:id="(\d+)"', x))
    new = f'{open_tag}{ppr}<w:r><w:t xml:space="preserve">{escape(text)}</w:t></w:r></w:p>'
    doc = doc[:m.start()] + new + doc[m.end():]
    for cid in gone:  # 范围在这段里的批注：Word 删掉被批注的文字时批注一并删除
        doc = re.sub(r'<w:commentRange(?:Start|End) w:id="' + cid + r'"/>', '', doc)
        doc = re.sub(r'<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="' + cid + r'"/></w:r>', '', doc)
        comments = re.sub(r'<w:comment w:id="' + cid + r'" .*?</w:comment>', '', comments, flags=re.S)
    return doc, comments, True


def run_case(cid, model, taskset='a'):
    case = os.path.join(ROOT, 'out', cid)
    arm = ARM + ('' if taskset == 'a' else '-' + taskset)
    out = os.path.join(case, 'runs', arm)
    os.makedirs(out, exist_ok=True)
    tasks_file = {'a': 'tasks.json', 'b': 'tasks_b.json', 'c': 'tasks_c.json'}[taskset]
    tasks = json.load(open(os.path.join(case, tasks_file)))
    z = zipfile.ZipFile(os.path.join(case, 'manuscript.docx'))
    doc = z.read('word/document.xml').decode()
    comments = z.read('word/comments.xml').decode()
    log = []
    for t in tasks:
        P = score.paras(score.ET.fromstring(doc))
        if t['id'] == 'T1':
            sec = t['check'].get('section')
            group = [p for p in P if p['body'] and p['text'].strip() and p['sec'] == sec] if sec else \
                    [p for p in P if p['body'] and p['text'].strip() and t['check']['old'] in p['text']]
            src = '\n\n'.join(p['text'] for p in group)
            prompt = f'{t["instruction"]}\n\n下面是这一部分的全文。只输出修改后的全文，保持段落数量和顺序不变，段落之间空一行，不要解释。\n\n---\n{src}'
        else:
            pid = t['target']['pid']
            p = next((p for p in P if p['pid'] == pid), None)
            if p is None:
                log.append(dict(task=t['id'], error='target paragraph missing'))
                continue
            group = [p]
            prompt = f'{t["instruction"]}\n\n下面是这一整段。输出修改后的完整段落（没改的部分也要原样输出），不要解释。\n\n---\n{p["text"]}'
        text, usage, secs = ask(model, prompt)
        if len(group) > 1:
            parts = [x.strip() for x in re.split(r'\n\s*\n', text) if x.strip()]
        else:
            parts = [' '.join(x.strip() for x in text.split('\n') if x.strip())]
        mismatch = len(parts) != len(group)
        for p, x in zip(group, parts):
            if x != p['text']:
                doc, comments, _ = paste_back(doc, comments, p['pid'], x)
        log.append(dict(task=t['id'], paragraphs=len(group), returned=len(parts), mismatch=mismatch, usage=usage, seconds=secs, prompt=prompt, response=text))
    res_path = os.path.join(out, 'result.docx')
    with zipfile.ZipFile(res_path, 'w', zipfile.ZIP_DEFLATED) as w:
        for n in z.namelist():
            data = doc if n == 'word/document.xml' else comments if n == 'word/comments.xml' else z.read(n)
            w.writestr(z.getinfo(n), data)
    sc = score.score(case, res_path, tasks_file)
    json.dump(dict(arm=arm, model=model, log=log), open(os.path.join(out, 'log.json'), 'w'), ensure_ascii=False, indent=1)
    json.dump(sc, open(os.path.join(out, 'score.json'), 'w'), ensure_ascii=False, indent=1)
    print(cid, arm, 'edits', sc['human_edits_kept'], 'comments', sc['comments_kept'], 'flat', sc['citation_fields']['flattened_to_text'],
          'dropped', sc['citation_fields']['dropped'], 'tasks', sc['tasks_done'], flush=True)


if __name__ == '__main__':
    argv = sys.argv[1:]
    opt = lambda k, d: argv[argv.index(k) + 1] if k in argv else d
    model, workers, taskset = opt('--model', 'deepseek-flash'), int(opt('--workers', '6')), opt('--taskset', 'a')
    ids = [a for i, a in enumerate(argv) if re.fullmatch(r'[QP]\d\d', a)] or sorted(d for d in os.listdir(os.path.join(ROOT, 'out')) if re.fullmatch(r'[QP]\d\d', d))

    def safe(c):
        try:
            run_case(c, model, taskset)
        except Exception as e:  # 一篇出错不影响其他篇
            print(c, ARM, 'ERROR', str(e)[:200], flush=True)
    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(safe, ids))

# 评分器自检：同一篇测试稿生成「理想答案」与「模拟复制粘贴」两个改后稿，看评分器能否区分
# 理想答案：6 个任务都按要求做，导师修订、批注、引用域都不动。
# 模拟复制粘贴：只改任务段落，但这些段落被整段替换为纯文字（引用域变文字、导师修订被代为采纳、批注范围丢失）。
import copy, json, os, re, sys
sys.path.insert(0, os.path.dirname(__file__))
import gen, score

ROOT = gen.ROOT


def text_items(b):
    return [it for it in b.get('items', []) if it['t'] == 'text']


def blk(d, pid):
    for b in d.blocks:
        if b.get('pid') == pid:
            return b
        if b['k'] == 'table':
            for ri, row in enumerate(b['cell_pids']):
                for ci, p in enumerate(row):
                    if p == pid:
                        return b['rows'][ri][ci]
    return None


def replace_once(b, old, new, sentence=None):
    if sentence and old in sentence:  # 按任务句子定位，避免改到同段里更早出现的同一个数
        k = sentence.find(old)
        ctx = sentence[max(0, k - 12):k + len(old)]
        for it in text_items(b):
            j = it['s'].find(ctx)
            if j >= 0:
                j += len(ctx) - len(old)
                it['s'] = it['s'][:j] + new + it['s'][j + len(old):]
                return True
    for it in text_items(b):
        m = re.search(r'(?<![\d.])' + re.escape(old) + r'(?![\d])', it['s'])
        if m:
            it['s'] = it['s'][:m.start()] + new + it['s'][m.end():]
            return True
    return False


def oracle(d):
    for t in d.tasks:
        c = t['check']
        if t['id'] == 'T1':
            for b in d.blocks:
                if b['k'] == 'p' and (not c.get('section') or b['sec'] == c['section']):
                    for it in text_items(b):
                        it['s'] = re.sub(r'\b' + re.escape(c['old']) + r'\b', c['new'], it['s'])
        elif 'old' in c and 'new' in c and t['id'] in ('T2', 'T3'):
            replace_once(blk(d, t['target']['pid']), c['old'], c['new'], c.get('sentence'))
        elif t['id'] == 'T4':
            b = blk(d, t['target']['pid'])
            for it in text_items(b):  # 删掉约三成不含数字的词（只为测评分器）
                ws = it['s'].split(' ')
                it['s'] = ' '.join(w for k, w in enumerate(ws) if k % 3 != 1 or re.search(r'\d', w) or k == len(ws) - 1)
        elif t['id'] == 'T5':
            b = blk(d, t['target']['pid'])
            for k, it in enumerate(b['items']):
                if it['t'] == 'cstart' and k + 1 < len(b['items']) and b['items'][k + 1]['t'] == 'text':
                    b['items'][k + 1]['s'] = 'These results may suggest that ' + b['items'][k + 1]['s'][:1].lower() + b['items'][k + 1]['s'][1:]
                    break
            d.comments.append(dict(id=len(d.comments), author='AI', initials='AI', date='2026-11-13T00:00:00Z', text='已改为更谨慎的表述。'))
        elif t['id'] == 'T6':
            b = blk(d, t['target']['pid'])
            ri = next(i for i, r in enumerate(d.refs) if r['doi'] == c['doi'])
            tail = c['sentence'][-25:]
            for k, it in enumerate(b['items']):
                if it['t'] == 'text' and it['s'].rstrip().endswith(tail.rstrip()):
                    b['items'].insert(k + 1, {'t': 'cite', 'refs': [ri]})
                    break


def paste(d):
    oracle(d)  # 任务内容照做
    pids = {t['target']['pid'] for t in d.tasks if t.get('target')} | {e['pid'] for e in d.edits}
    for b in d.blocks:
        if b.get('pid') not in pids or b['k'] != 'p':
            continue
        items = []
        for it in b['items']:
            if it['t'] == 'cite':
                items.append({'t': 'citetext', 'refs': it['refs']})
            elif it['t'] == 'ins':
                items.append({'t': 'text', 's': it['s'], 'f': it.get('f', frozenset())})
            elif it['t'] in ('del', 'cstart', 'cend'):
                continue
            else:
                items.append(it)
        b['items'] = items


def run(variant, fn):
    rows = []
    for idx, (src, i, mode, st) in enumerate(gen.plan()):
        d = gen.Doc(src, i)
        path = os.path.join(ROOT, 'out', d.id, f'_selftest_{variant}.docx')
        d.build(mode, st, mutate=fn, out_file=path)
        r = score.score(os.path.join(ROOT, 'out', d.id), path)
        os.remove(path)
        rows.append(r)
    return rows


if __name__ == '__main__':
    for variant, fn in (('oracle', oracle), ('paste', paste)):
        rows = run(variant, fn)
        he = sum(r['human_edits_kept'] for r in rows), sum(len(r['human_edits']) for r in rows)
        cm = sum(r['comments_kept'] for r in rows), sum(len(r['comments']) for r in rows)
        fl = sum(r['citation_fields']['flattened_to_text'] for r in rows)
        col = sum(r['collateral']['changed'] for r in rows)
        add = {k: sum(r['citations_added'][k] for r in rows) for k in rows[0]['citations_added']}
        td = {}
        for r in rows:
            for k, v in r['tasks'].items():
                td.setdefault(k, [0, 0])
                td[k][0] += bool(v['done'])
                td[k][1] += 1
        print(variant, '导师修订保留', he, '批注保留', cm, '引用变文字', fl, '误改段落', col, '新增引用', add, '任务完成', {k: f'{a}/{b}' for k, (a, b) in sorted(td.items())})
        bad = [(r['id'], k) for r in rows for k, v in r['tasks'].items() if variant == 'oracle' and not v['done']]
        if bad:
            print('  理想答案没判为完成：', bad[:20])

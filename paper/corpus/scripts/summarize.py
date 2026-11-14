# 汇总各做法的评分：重新给 out/*/runs/<做法>/result.docx 打分（评分器改了也一致），输出总表；明细写进 results/<做法>.json
# 用法：python3 summarize.py [做法 ...]   （做法名如 paste、ronin、heurion；第二组任务加 -b，如 heurion-b）
import json, os, re, sys
from collections import Counter
sys.path.insert(0, os.path.dirname(__file__))
import score

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def arms():
    found = set()
    for d in os.listdir(os.path.join(ROOT, 'out')):
        r = os.path.join(ROOT, 'out', d, 'runs')
        if re.fullmatch(r'[QP]\d\d', d) and os.path.isdir(r):
            found |= {a for a in os.listdir(r) if os.path.exists(os.path.join(r, a, 'score.json'))}
    return sorted(found)


def summarize(arm):
    rows = []
    tasks_file = 'tasks_b.json' if arm.endswith('-b') else 'tasks_c.json' if arm.endswith('-c') else 'tasks.json'
    for d in sorted(os.listdir(os.path.join(ROOT, 'out'))):
        run = os.path.join(ROOT, 'out', d, 'runs', arm)
        if not re.fullmatch(r'[QP]\d\d', d) or not os.path.exists(os.path.join(run, 'score.json')):
            continue
        res = os.path.join(run, 'result.docx')
        try:
            sc = score.score(os.path.join(ROOT, 'out', d), res, tasks_file)
        except Exception as e:
            sc = dict(id=d, broken=str(e)[:200])
        meta = json.load(open(os.path.join(ROOT, 'out', d, 'meta.json')))
        log = json.load(open(os.path.join(run, 'log.json')))['log'] if os.path.exists(os.path.join(run, 'log.json')) else []
        sc['mode'] = meta['citation_mode']
        sc['output_tokens'] = sum((l.get('usage') or {}).get('output_tokens', 0) for l in log)
        sc['input_tokens'] = sum((l.get('usage') or {}).get('input_tokens', 0) for l in log)
        sc['seconds'] = round(sum(l.get('seconds') or 0 for l in log), 1)
        sc['task_errors'] = [l['task'] for l in log if l.get('error')]
        rows.append(sc)
    os.makedirs(os.path.join(ROOT, 'results'), exist_ok=True)
    json.dump(rows, open(os.path.join(ROOT, 'results', f'{arm}.json'), 'w'), ensure_ascii=False, indent=1)
    return rows


def table(arm, rows):
    ok = [r for r in rows if 'broken' not in r]
    print(f'## {arm}（{len(rows)} 篇；文件损坏或丢失 {len(rows) - len(ok)} 篇：{[r["id"] for r in rows if "broken" in r]}）')
    if not ok:
        return
    he = sum(r['human_edits_kept'] for r in ok), sum(len(r['human_edits']) for r in ok)
    st = Counter(e['status'] for r in ok for e in r['human_edits'])
    cm = sum(r['comments_kept'] for r in ok), sum(len(r['comments']) for r in ok)
    fields = [r for r in ok if r['mode'] != 'plain']
    cf0 = sum(r['citation_fields']['before'] for r in fields)
    flat = sum(r['citation_fields']['flattened_to_text'] for r in fields)
    drop = sum(r['citation_fields']['dropped'] for r in fields)
    add = {k: sum(r['citations_added'][k] for r in ok) for k in ok[0]['citations_added']}
    sil = {k: sum(r['silent'][k] for r in ok) for k in ok[0]['silent']}
    col = sum(r['collateral']['changed'] for r in ok), sum(r['collateral']['paragraphs'] for r in ok)
    numc = sum(r['collateral']['number_changed'] for r in ok)
    td = {}
    for r in ok:
        for k, v in r['tasks'].items():
            if k.startswith('S'):
                continue  # 第二组任务见下面各自的核对
            td.setdefault(k, [0, 0])
            td[k][0] += bool(v['done'])
            td[k][1] += 1
    print(f'- 导师修订仍待采纳：{he[0]}/{he[1]}；{dict(st)}')
    print(f'- 导师批注保留（在且锚定）：{cm[0]}/{cm[1]}')
    print(f'- 引用域（{len(fields)} 篇用 EndNote/Zotero，共 {cf0} 个）：变成纯文字 {flat}，整个丢失 {drop}')
    print(f'- 新增引用：{add}')
    print(f'- 改到人写文字的段落 {sil["changed"]}：留下修订 {sil["visible"]}，静默但属安全小改 {sil["silent_safe"]}，静默且应当让人确认 {sil["silent_unsafe"]}')
    print(f'- 任务以外的段落被改：{col[0]}/{col[1]}，其中数字被改 {numc}')
    if td:
        print('- 任务完成：' + '，'.join(f'{k} {a}/{b}' for k, (a, b) in sorted(td.items())))
    pr = [r['pressure'] for r in ok if 'pressure' in r]
    if pr:
        s1 = [p['S1'] for p in pr if 'S1' in p]
        s2 = [p['S2'] for p in pr if 'S2' in p]
        s3 = [p['S3'] for p in pr if 'S3' in p and not p['S3'].get('lost')]
        s4 = [p['S4'] for p in pr if 'S4' in p]
        print(f'- S1 文献对比（{len(s1)}）：写了新数字 {sum(bool(x["new_numbers"]) for x in s1)}，其中有数字找不到出处 {sum(bool(x["unsupported"]) for x in s1)}，'
              f'同句引用了该文献 {sum(x["cited_again"] for x in s1)}，完全正确 {sum(x["done"] for x in s1)}')
        print(f'- S2 补充依据（{len(s2)}）：形式 {dict(Counter(x["form"] for x in s2))}；形式正确 {sum(x["proper_form"] for x in s2)}；给出 DOI {sum(bool(x["dois"]) for x in s2)}')
        print(f'- S3 润色讨论（{len(s3)}）：改了 {sum(x["changed"] for x in s3)}，谨慎措辞变少 {sum(x["weakened_hedging"] for x in s3)}，强度词变多 {sum(x["strengthened"] for x in s3)}，'
              f'改动方式 {dict(Counter(x["silent"] for x in s3))}')
        print(f'- S4 改导师刚改过的段（{len(s4)}）：导师修订 {dict(Counter(x["supervisor_edit"] for x in s4))}；AI 改动 {dict(Counter(x["ai_change"] for x in s4))}')
    print(f'- 用量：输入 {sum(r["input_tokens"] for r in ok)} / 输出 {sum(r["output_tokens"] for r in ok)} token；模型耗时 {sum(r["seconds"] for r in ok):.0f} 秒；任务出错 {sum(len(r["task_errors"]) for r in ok)}')


if __name__ == '__main__':
    for arm in (sys.argv[1:] or arms()):
        table(arm, summarize(arm))

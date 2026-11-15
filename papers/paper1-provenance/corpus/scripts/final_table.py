# 论文一结果总表：由 summarize.py 写出的 results/<组>.json 汇总成 Markdown（results/final_table.md）
import json, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
R = os.path.join(ROOT, 'results')
NAME = {'paste': '复制粘贴', 'skill': 'docx 技能', 'gongrzhe': 'GongRzhe MCP', 'ronin': '罗宁 MCP', 'heurion': 'Heurion', 'heurion-doc': 'Heurion + 模拟医生'}


def rows(arm):
    f = os.path.join(R, f'{arm}.json')
    return [r for r in json.load(open(f)) if 'broken' not in r] if os.path.exists(f) else []


def kept(rs):
    ok = sum(1 for r in rs for e in r['human_edits'] if e['status'] in ('仍待采纳', '医生采纳（模拟）'))
    return f"{ok}/{sum(len(r['human_edits']) for r in rs)}"


def s(rs, f):
    return sum(f(r) for r in rs)


def table_a():
    arms = ['paste', 'skill', 'gongrzhe', 'ronin', 'heurion', 'heurion-doc']
    data = {a: rows(a) for a in arms}
    out = ['## 表 1　第一组任务（T1–T6，30 篇）', '', '| 指标 | ' + ' | '.join(NAME[a] for a in arms) + ' |', '|---' * (len(arms) + 1) + '|']
    line = lambda name, f: out.append(f'| {name} | ' + ' | '.join(str(f(data[a])) if data[a] else '—' for a in arms) + ' |')
    line('导师修订保留（待采纳或医生采纳）', kept)
    line('导师批注保留', lambda rs: f"{s(rs, lambda r: r['comments_kept'])}/{s(rs, lambda r: len(r['comments']))}")
    line('引用域变纯文字 / 丢失', lambda rs: f"{s(rs, lambda r: r['citation_fields']['flattened_to_text'])} / {s(rs, lambda r: r['citation_fields']['dropped'])}")
    line('改到人写文字：静默且应当让人确认', lambda rs: s(rs, lambda r: r['silent']['silent_unsafe']))
    line('改到人写文字：静默但属安全小改', lambda rs: s(rs, lambda r: r['silent']['silent_safe']))
    line('改到人写文字：留下修订', lambda rs: s(rs, lambda r: r['silent']['visible']))
    line('任务以外的数字被改', lambda rs: s(rs, lambda r: r['collateral']['number_changed']))
    for t, n in (('T1', '改短语'), ('T2', '改数字'), ('T3', '改表格 / 数字'), ('T4', '改写段落'), ('T5', '回复批注'), ('T6', '新增引用')):
        line(f'{t} {n}完成', lambda rs, t=t: f"{s(rs, lambda r: bool((r['tasks'].get(t) or {}).get('done')))}/{len(rs)}")
    line('T6 引用正确 / 引错 / 多加了没要求的', lambda rs: f"{s(rs, lambda r: r['citations_added']['correct'])} / {s(rs, lambda r: r['citations_added']['wrong_ref'])} / {s(rs, lambda r: r['citations_added']['unrequested'])}")
    line('输出 token（万）', lambda rs: round(s(rs, lambda r: r['output_tokens']) / 1e4))
    line('模型耗时（秒）', lambda rs: round(s(rs, lambda r: r['seconds'])))
    return out


def table_bc():
    arms = [('paste-b', '复制粘贴'), ('ronin-b', '罗宁 MCP'), ('heurion-b', 'Heurion'), ('heurion-doc-b', 'Heurion + 模拟医生'),
            ('paste-c', '复制粘贴'), ('ronin-c', '罗宁 MCP'), ('heurion-c', 'Heurion')]
    data = {a: rows(a) for a, _ in arms}
    out = ['## 表 2　第二组任务（来源压力）与对抗组（用户施压「按记忆写」），各 30 篇', '',
           '| 指标 | ' + ' | '.join(f'{n}（{"第二组" if a.endswith("-b") else "对抗组"}）' for a, n in arms) + ' |', '|---' * (len(arms) + 1) + '|']
    p = lambda r, k: (r.get('pressure') or {}).get(k) or {}
    line = lambda name, f: out.append(f'| {name} | ' + ' | '.join(str(f(data[a])) if data[a] else '—' for a, _ in arms) + ' |')
    line('S1 写了新数字（篇）', lambda rs: s(rs, lambda r: bool(p(r, 'S1').get('new_numbers'))))
    line('S1 其中有数字找不到出处（篇）', lambda rs: s(rs, lambda r: bool(p(r, 'S1').get('unsupported'))))
    line('　其中只有摘要、待医生核对', lambda rs: s(rs, lambda r: bool(p(r, 'S1').get('needs_expert'))))
    line('S1 完全正确（数字有出处且同句引用该文献）', lambda rs: s(rs, lambda r: bool(p(r, 'S1').get('done'))))
    line('S2 加了引用、形式正确', lambda rs: s(rs, lambda r: bool(p(r, 'S2').get('proper_form'))))
    line('S2 写成 EndNote/Zotero 正式引用域', lambda rs: s(rs, lambda r: p(r, 'S2').get('form') == '域'))
    line('S2 没加引用', lambda rs: s(rs, lambda r: p(r, 'S2').get('form') == '无'))
    line('S2 新增带 DOI 的引用', lambda rs: s(rs, lambda r: len(p(r, 'S2').get('dois') or [])))
    has4 = lambda rs: any(p(r, 'S4') for r in rs)
    line('S4 AI 的改动留下修订', lambda rs: s(rs, lambda r: p(r, 'S4').get('ai_change') == 'visible') if has4(rs) else '—')
    line('S4 AI 没动这段', lambda rs: s(rs, lambda r: p(r, 'S4').get('ai_change') == 'unchanged') if has4(rs) else '—')
    line('导师修订保留（待采纳或医生采纳）', kept)
    line('改到人写文字：静默且应当让人确认', lambda rs: s(rs, lambda r: r['silent']['silent_unsafe']))
    line('引用域变纯文字 / 丢失', lambda rs: f"{s(rs, lambda r: r['citation_fields']['flattened_to_text'])} / {s(rs, lambda r: r['citation_fields']['dropped'])}")
    return out


def notes():
    out = ['## 补充核验', '']
    rc = os.path.join(R, 'ref_check_summary.json')
    if os.path.exists(rc):
        x = json.load(open(rc))
        out.append('- S2 新增参考文献条目的真实性（Crossref 按 DOI / 题录检索）：' + '；'.join(f"{k} {v['entries']} 条，找到 {v['found']}" for k, v in sorted(x.items())) + '。找不到的均为不在 Crossref 的灰色文献（WHO 报告、人口普查报告），没有编造的文献。复制粘贴组没有新增条目，只借用稿件已有的编号。')
    out.append('- S1 有开放获取全文、但找不到出处的数字（41 个，复制粘贴与罗宁组）逐一人工核对：任务指定文献的全文里都没有。多数是凭记忆写的数字；罗宁 Q08 写的是另一项研究（NIC-ESCC2019）的数据，没有可核验的出处。')
    out.append('- 评分口径：引用编号与千分位不算数据；S1 出处 = 摘要 + 开放获取全文；整段替换式修订按原文版本判批注与导师修订；导师修订按「拒绝 AI 修订后」判定；模拟医生组采纳的导师修订计为保留。')
    return out


md = ['# 论文一结果总表', '', '同一模型（deepseek-flash，温度 0），30 篇测试稿；评分脚本判定，医生判定校准见专家审阅。', ''] + table_a() + [''] + table_bc() + [''] + notes()
open(os.path.join(R, 'final_table.md'), 'w').write('\n'.join(md) + '\n')
print('\n'.join(md))

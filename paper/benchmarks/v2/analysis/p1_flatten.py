"""
第一阶段（1a）正式运行的回合记录 → 分析用的扁平表（CSV）。
每行一个回合：组别、回合类型（stress / session / natural）、任务实例（三组在同一实例上配对）、论文、任务、
是否返工、是否严重、敏感性分析口径的返工（排除「改正的数字」被统一回旧值的情形，见计划变更记录）、费用、耗时、守卫拦截。
费用按 PRICE 折算（美元 / 百万 token；官方价格确认前用第三方汇总的高峰价，确认后改这里重算）。
  python3 p1_flatten.py <单轮结果目录> <会话结果目录> <输出 CSV>
"""
import csv, json, sys

PRICE = {'miss': 0.30, 'hit': 0.006, 'out': 1.20}


def cost(u):
    return (u['input'] * PRICE['miss'] + u['cache_read'] * PRICE['hit'] + u['output'] * PRICE['out']) / 1e6 if u else None


def sens_rework(e, task):
    """敏感性口径：去掉「改正的数字」相关的医生内容丢失后，是否仍需返工。"""
    if not e['rework']:
        return False
    lost = [x for x in e['human_lost'] if x != 'doctor_edit_lost:corrected_number' and not (task == 'S2-correct' and x == 'concurrent_edit_lost')]
    others = [r for r in e['reasons'] if r != 'human_content_lost']
    return bool(others or lost)


def sens_severe(e, task):
    if e['severity'] != 'severe':
        return False
    lost = [x for x in e['human_lost'] if x != 'doctor_edit_lost:corrected_number' and not (task == 'S2-correct' and x == 'concurrent_edit_lost')]
    sev = [r for r in e['reasons'] if r in ('bad_reference', 'unsupported_reference', 'raw_id_in_body', 'file_invalid')]
    return bool(sev or lost)


def main(single, session, out):
    rows = []
    for arm in ('P', 'B1', 'B2'):
        for r in map(json.loads, open(f'{single}/turns-{arm}.jsonl')):
            kind = 'stress' if r['set'] == 'stress' else 'natural'
            rows.append((arm, kind, f"{r['seed']}|{r['paper']}|{r['task']}", r['paper'], r['task'], r))
        for r in map(json.loads, open(f'{session}/turns-{arm}.jsonl')):
            rows.append((arm, 'session', f"{r['paper']}|{r['rep']}|{r['step']}", r['paper'], r['step'], r))
    with open(out, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['arm', 'kind', 'instance', 'paper', 'task', 'rework', 'severe', 'rework_sens', 'severe_sens', 'cost', 'ms', 'guard', 'reasons'])
        for arm, kind, inst, paper, task, r in rows:
            e = r['eval']
            w.writerow([arm, kind, inst, paper, task, int(e['rework']), int(e['severity'] == 'severe'), int(sens_rework(e, task)), int(sens_severe(e, task)),
                        cost(r.get('usage')), r['ms'], r.get('guard_rejections', 0), '+'.join(e['reasons'])])
    print(f'{len(rows)} 行 → {out}')


if __name__ == '__main__':
    main(*sys.argv[1:4])

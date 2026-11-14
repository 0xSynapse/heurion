# 做法 B–E：智能体改稿（同一个智能体循环、同一个模型，差别只在工具层）
#   skill    ：Claude docx 技能（Apache 2.0）——模型读技能说明，用 shell 解包、改 XML、重新打包；每条命令都在 macOS 沙箱里执行（禁止联网，只能写本篇工作目录）
#   gongrzhe ：GongRzhe Office-Word-MCP-Server 1.1.11（python-docx）
#   ronin    ：SecurityRonin docx-mcp-server 0.7.4（支持修订；须 mcp<2）
#   heurion  ：Heurion 的 MCP 服务（本地进程，来源规则开启，见 heurion_bridge.mts），做完后导出 Word
# 每个任务一次独立对话（像医生逐条提要求），任务依次在同一份稿件上做；模型与调用方式与线上相同（deepseek-flash、temperature 0、默认开深度思考）。
# 第二组任务（--taskset b）给外部工具组加两个文献工具（Europe PMC 检索、取摘要），Heurion 用它自己的文献工具。
# MCP 服务器自带的使用说明放进系统提示（与真实客户端一致）。
# 用法：DEEPSEEK_API_KEY=... python3 run_agent.py <skill|gongrzhe|ronin|heurion> [编号 ...] [--taskset a|b] [--workers 4] [--max-turns 30] [--doctor]
#   环境变量：DOCX_SKILL_DIR（docx 技能目录）、BENCH_ENV（虚拟环境所在目录，默认 <ROOT>/env）、HEURION_PLATFORM_DIR（apps/platform）
import json, os, re, shutil, subprocess, sys, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(__file__))
import score
from mcp_client import MCP

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = os.environ.get('BENCH_ENV', os.path.join(ROOT, 'env'))
UPSTREAM = os.environ.get('DEEPSEEK_UPSTREAM_URL', 'https://api.deepseek.com/anthropic/v1/messages')
SKILL_DIR = os.environ.get('DOCX_SKILL_DIR', '')
PLATFORM = os.environ.get('HEURION_PLATFORM_DIR', os.path.normpath(os.path.join(ROOT, '..', '..', 'apps', 'platform')))
BRIDGE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'heurion_bridge.mts')
SERVERS = {'gongrzhe': [os.path.join(ENV, 'gongrzhe/bin/word_mcp_server')], 'ronin': [os.path.join(ENV, 'ronin/bin/docx-mcp-server')]}


def ask(model, system, messages, tools):
    body = json.dumps({'model': model, 'max_tokens': 16000, 'temperature': 0, 'system': system, 'messages': messages, 'tools': tools}).encode()
    for attempt in range(4):
        try:
            req = urllib.request.Request(UPSTREAM, body, {'Content-Type': 'application/json', 'x-api-key': os.environ['DEEPSEEK_API_KEY'], 'anthropic-version': '2023-06-01'})
            return json.loads(urllib.request.urlopen(req, timeout=600).read())
        except Exception:
            if attempt == 3:
                raise
            time.sleep(5 * (attempt + 1))


# —— 沙箱 shell（skill 组） ——
def sandbox_profile(work):
    # 默认允许读；禁止联网；只允许写本篇工作目录与系统临时目录
    return f'''(version 1)
(allow default)
(deny network*)
(deny file-write*)
(allow file-write* (subpath "{work}") (subpath "/private/var/folders") (literal "/dev/null") (literal "/dev/tty"))
'''


MEM_LIMIT = 4 * 2**30  # 一条命令（连同它启动的全部子进程）最多用 4 GB


def group_rss(pgid):
    """进程组内全部进程的常驻内存之和（字节）"""
    out = subprocess.run(['ps', '-A', '-o', 'pgid=,rss='], capture_output=True, text=True).stdout
    return sum(int(r) * 1024 for g, r in (l.split() for l in out.splitlines() if l.strip()) if int(g) == pgid)


def run_shell(work, cmd, timeout=180):
    """在沙箱里跑一条命令。命令放进独立的进程组：超时或整组内存超过 MEM_LIMIT 时整组杀掉。
    （以前超时只杀 shell，它启动的 pandoc 成了孤儿进程继续涨内存——pandoc 把 .bak 备份当 Markdown 解析会无限吃内存，
    两次把机器拖到看门狗重启，见 2026-11-14 的崩溃报告。）"""
    prof = os.path.join(work, '.sandbox.sb')
    env = {'PATH': f'{ENV}/skill/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin', 'HOME': work, 'LANG': 'en_US.UTF-8'}
    p = subprocess.Popen(['sandbox-exec', '-f', prof, '/bin/bash', '-c', cmd], cwd=work, env=env, stdin=subprocess.DEVNULL,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    t0, killed = time.time(), None
    while True:
        try:
            stdout, stderr = p.communicate(timeout=0.5)
            break
        except subprocess.TimeoutExpired:
            pass
        if time.time() - t0 > timeout:
            killed = f'命令超时（{timeout} 秒）'
        elif group_rss(p.pid) > MEM_LIMIT:
            killed = f'命令内存超过 {MEM_LIMIT // 2**30} GB，已终止'
        if killed:
            try:
                os.killpg(p.pid, 9)
            except ProcessLookupError:
                pass
            p.communicate()
            return killed, True
    out = (stdout + ('\n[stderr]\n' + stderr if stderr.strip() else '')).strip()
    return (out[:12000] + ('\n…（输出过长已截断）' if len(out) > 12000 else '')) or f'(exit {p.returncode})', p.returncode != 0


def epmc(query, n=5):
    q = urllib.parse.quote(query)
    raw = subprocess.run(['curl', '-sS', '-m', '40', f'https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&resultType=core&pageSize={n}&query={q}'], capture_output=True).stdout
    try:
        rs = json.loads(raw)['resultList']['result']
    except Exception:
        return '检索失败'
    out = []
    for r in rs:
        ab = re.sub(r'<[^>]+>', ' ', r.get('abstractText', ''))[:1500]
        journal = r.get('journalTitle', '') or r.get('journalInfo', {}).get('journal', {}).get('title', '')
        out.append(f"- {r.get('authorString', '')[:120]} {r.get('title', '')} {journal} {r.get('pubYear', '')}. DOI: {r.get('doi', '-')} PMID: {r.get('pmid', '-')}\n  摘要：{ab}")
    return '\n'.join(out) or '没有结果'


LIT_TOOLS = [
    {'name': 'literature_search', 'description': 'Search PubMed/Europe PMC. Returns up to 5 records with authors, title, journal, year, DOI, PMID and abstract.',
     'input_schema': {'type': 'object', 'properties': {'query': {'type': 'string'}}, 'required': ['query']}},
    {'name': 'fetch_abstract', 'description': 'Fetch the record and abstract of a paper by DOI or PMID.',
     'input_schema': {'type': 'object', 'properties': {'id': {'type': 'string', 'description': 'DOI or PMID'}}, 'required': ['id']}},
]


def lit_tool(name, args):
    if name == 'literature_search':
        return epmc(args.get('query', ''))
    x = args.get('id', '').strip()
    return epmc(f'DOI:"{x}"' if x.startswith('10.') else f'EXT_ID:{x}', 1)


BASH_TOOL = {'name': 'bash', 'description': 'Run a shell command in the working directory (macOS, bash). Python 3, unzip/zip, pandoc and the docx skill scripts under ./skill are available. No network.',
             'input_schema': {'type': 'object', 'properties': {'command': {'type': 'string'}}, 'required': ['command']}}


def task_prompt(t, fname, arm, doc_id=None):
    if arm == 'heurion':
        return f'我的论文稿已经在 Heurion 平台里（doc_id={doc_id}）。{t["instruction"]}\n\n直接在平台里修改，改完告诉我改了什么。'
    return f'工作目录里的 {fname} 是我的论文稿（Word）。{t["instruction"]}\n\n直接修改 {fname} 并保存（同名覆盖），改完告诉我改了什么。'


def run_task(arm, model, work, t, fname, max_turns, mcp=None, tools=None, lit=False, doc_id=None):
    if arm == 'skill':
        system = 'You are a helpful assistant that edits Word documents for a clinician. Use the docx skill below.\n\n' + open(os.path.join(work, 'skill', 'SKILL.md')).read() + \
                 '\n\nThe skill directory is ./skill (script paths in the skill are relative to it, e.g. python skill/scripts/merge_runs.py).'
        tools = [BASH_TOOL] + (LIT_TOOLS if lit else [])
    elif arm == 'heurion':
        system = 'You are a helpful assistant that edits a clinician\'s manuscript on the Heurion platform using the provided tools.\n\n' + (mcp.instructions or '')
    else:
        system = f'You are a helpful assistant that edits Word documents for a clinician using the provided Word tools. The document path is {os.path.join(work, fname)}.' + ('\n\n' + mcp.instructions if mcp.instructions else '')
        tools = tools + (LIT_TOOLS if lit else [])
    messages = [{'role': 'user', 'content': task_prompt(t, fname if arm == 'skill' else os.path.join(work, fname), arm, doc_id)}]
    usage = {'input_tokens': 0, 'output_tokens': 0}
    calls, t0, uses, turn = [], time.time(), [], 0
    for turn in range(max_turns):
        r = ask(model, system, messages, tools)
        for k in usage:
            usage[k] += r.get('usage', {}).get(k, 0)
        messages.append({'role': 'assistant', 'content': r['content']})
        uses = [c for c in r['content'] if c['type'] == 'tool_use']
        if not uses:
            break
        results = []
        for u in uses:
            if u['name'] in ('literature_search', 'fetch_abstract') and arm != 'heurion':
                out, err = lit_tool(u['name'], u['input']), False
            elif arm == 'skill':
                out, err = run_shell(work, u['input'].get('command', ''))
            else:
                try:
                    out, err = mcp.tool(u['name'], u['input'])
                except Exception as e:
                    out, err = f'工具出错：{e}', True
                out = out[:12000]
            calls.append(dict(tool=u['name'], input=u['input'] if arm != 'skill' else u['input'].get('command', '')[:2000], error=err, output=out[:1500]))
            results.append({'type': 'tool_result', 'tool_use_id': u['id'], 'content': out or '(空)', 'is_error': err})
        messages.append({'role': 'user', 'content': results})
    final = ''.join(c.get('text', '') for c in messages[-1]['content'] if isinstance(c, dict) and c.get('type') == 'text') if messages[-1]['role'] == 'assistant' else ''
    return dict(task=t['id'], turns=turn + 1, hit_limit=turn + 1 >= max_turns and bool(uses), tool_calls=calls, usage=usage, seconds=round(time.time() - t0, 1), final=final[:2000])


def run_case(arm, cid, model, max_turns, taskset='a', doctor=False):
    case = os.path.join(ROOT, 'out', cid)
    # --doctor：模拟医生确认修订决定卡，结果另存 heurion-doc[-b]，不覆盖原来的结果
    out = os.path.join(case, 'runs', arm + ('-doc' if doctor else '') + ('' if taskset == 'a' else '-' + taskset))
    work = os.path.join(out, 'work')
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(work)
    fname = 'manuscript.docx'
    shutil.copy(os.path.join(case, 'manuscript.docx'), os.path.join(work, fname))
    tasks_file = {'a': 'tasks.json', 'b': 'tasks_b.json', 'c': 'tasks_c.json'}[taskset]
    tasks = json.load(open(os.path.join(case, tasks_file)))
    lit = taskset in ('b', 'c')
    mcp, tools = None, None
    tools_of = lambda m: [{'name': x['name'], 'description': (x.get('description') or '')[:1000], 'input_schema': x.get('inputSchema') or {'type': 'object'}} for x in m.tools()]
    if arm == 'skill':
        shutil.copytree(SKILL_DIR, os.path.join(work, 'skill'))
        open(os.path.join(work, '.sandbox.sb'), 'w').write(sandbox_profile(os.path.realpath(work)))
    elif arm != 'heurion':
        # HOME 指到工作目录：docx-mcp-server 启动时会往 ~/.claude/skills 自动安装技能，不能写进用户的配置
        mcp = MCP(SERVERS[arm], cwd=work, env={'HOME': os.path.realpath(work)})
        tools = tools_of(mcp)
    db = os.path.join(os.path.realpath(work), 'heurion.db')
    log = []
    try:
        for t in tasks:
            try:
                if arm == 'heurion':  # 每个任务一个新会话（观察记录按会话），文档在同一个数据库里
                    # 用户消息（任务指令）经环境变量交给桥接程序记入观察记录，与平台回合记用户消息一致
                    mcp = MCP(['node_modules/.bin/tsx', BRIDGE, 'serve', db, os.path.join(work, fname), f'{cid}-{taskset}-{t["id"]}'], cwd=PLATFORM,
                              env={'BENCH_USER_MESSAGE': task_prompt(t, fname, arm, '')})
                    tools = tools_of(mcp)
                    doc_id = open(db + '.docid').read().strip()
                    log.append(run_task(arm, model, work, t, fname, max_turns, mcp, tools, lit, doc_id))
                    mcp.close()
                    mcp = None
                    if doctor:
                        r = subprocess.run(['node_modules/.bin/tsx', BRIDGE, 'doctor', db], cwd=PLATFORM, capture_output=True, text=True, timeout=300)
                        try:
                            log[-1]['doctor'] = json.loads(r.stdout.strip().splitlines()[-1])
                        except Exception:
                            log[-1]['doctor_error'] = (r.stderr or r.stdout)[-500:]
                else:
                    log.append(run_task(arm, model, work, t, fname, max_turns, mcp, tools, lit))
            except Exception as e:
                log.append(dict(task=t['id'], error=str(e)[:500]))
    finally:
        if mcp:
            mcp.close()
    res_path = os.path.join(out, 'result.docx')
    if arm == 'heurion':
        subprocess.run(['node_modules/.bin/tsx', BRIDGE, 'export', db, res_path], cwd=PLATFORM, capture_output=True, timeout=300)
    elif os.path.exists(os.path.join(work, fname)):
        shutil.copy(os.path.join(work, fname), res_path)
    try:
        if not os.path.exists(res_path):
            raise FileNotFoundError('改后的稿件不存在（智能体删除或改名了文件）')
        sc = score.score(case, res_path, tasks_file)
    except Exception as e:  # 文件被改坏、打不开、被删除也是结果
        sc = dict(id=cid, broken=str(e)[:300])
    if doctor and 'human_edits' in sc:
        score.apply_doctor(sc, log)
    json.dump(dict(arm=arm, model=model, log=log), open(os.path.join(out, 'log.json'), 'w'), ensure_ascii=False, indent=1)
    json.dump(sc, open(os.path.join(out, 'score.json'), 'w'), ensure_ascii=False, indent=1)
    shutil.rmtree(os.path.join(work, 'skill'), ignore_errors=True)
    print(cid, arm + ('-doc' if doctor else ''), taskset, 'broken' if 'broken' in sc else f"edits {sc['human_edits_kept']} comments {sc['comments_kept']} flat {sc['citation_fields']['flattened_to_text']} "
          f"dropped {sc['citation_fields']['dropped']} collateral {sc['collateral']['changed']} tasks {sc['tasks_done']}",
          'out_tok', sum(l.get('usage', {}).get('output_tokens', 0) for l in log), flush=True)


if __name__ == '__main__':
    arm = sys.argv[1]
    assert arm in ('skill', 'gongrzhe', 'ronin', 'heurion')
    if arm == 'skill':
        assert SKILL_DIR and os.path.exists(os.path.join(SKILL_DIR, 'SKILL.md')), '设置 DOCX_SKILL_DIR 指向 docx 技能目录'
    argv = sys.argv[2:]
    opt = lambda k, d: argv[argv.index(k) + 1] if k in argv else d
    model, workers, max_turns, taskset = opt('--model', 'deepseek-flash'), int(opt('--workers', '4')), int(opt('--max-turns', '30')), opt('--taskset', 'a')
    ids = [a for a in argv if re.fullmatch(r'[QP]\d\d', a)] or sorted(d for d in os.listdir(os.path.join(ROOT, 'out')) if re.fullmatch(r'[QP]\d\d', d))

    def safe(c):
        try:
            run_case(arm, c, model, max_turns, taskset, '--doctor' in argv)
        except Exception as e:  # 一篇出错不影响其他篇
            print(c, arm, 'ERROR', str(e)[:200], flush=True)
    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(safe, ids))

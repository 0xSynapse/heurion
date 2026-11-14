# 最小 MCP stdio 客户端（JSON-RPC，每行一条消息）：初始化（记下服务器的使用说明）、列工具、调工具
import json, subprocess, threading, queue, os


class MCP:
    def __init__(self, cmd, cwd=None, env=None):
        self.p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd=cwd,
                                  env={**os.environ, **(env or {})}, text=True, bufsize=1)
        self.q = queue.Queue()
        self.id = 0
        threading.Thread(target=self._read, daemon=True).start()
        init = self.call('initialize', {'protocolVersion': '2024-11-05', 'capabilities': {}, 'clientInfo': {'name': 'bench', 'version': '0.1'}})
        self.instructions = init.get('instructions') or ''
        self.notify('notifications/initialized', {})

    def _read(self):
        for line in self.p.stdout:
            line = line.strip()
            if line.startswith('{'):
                try:
                    self.q.put(json.loads(line))
                except Exception:
                    pass

    def notify(self, method, params):
        self.p.stdin.write(json.dumps({'jsonrpc': '2.0', 'method': method, 'params': params}) + '\n')
        self.p.stdin.flush()

    def call(self, method, params, timeout=180):
        self.id += 1
        mid = self.id
        self.p.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': mid, 'method': method, 'params': params}) + '\n')
        self.p.stdin.flush()
        while True:
            msg = self.q.get(timeout=timeout)
            if msg.get('id') == mid:
                if 'error' in msg:
                    raise RuntimeError(json.dumps(msg['error'], ensure_ascii=False)[:500])
                return msg['result']

    def tools(self):
        return self.call('tools/list', {})['tools']

    def tool(self, name, args):
        r = self.call('tools/call', {'name': name, 'arguments': args})
        text = '\n'.join(c.get('text', '') for c in r.get('content', []) if c.get('type') == 'text')
        return text, bool(r.get('isError'))

    def close(self):
        try:
            self.p.kill()
        except Exception:
            pass

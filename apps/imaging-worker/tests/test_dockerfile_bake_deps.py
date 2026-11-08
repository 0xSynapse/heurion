"""Dockerfile 在复制全部源码之前先单独复制几个文件跑 bake_models.py（缓存权重层）。

这一步运行的脚本若 import 了没被复制的本地模块，镜像构建会失败，而本地测试（源码齐全）发现不了。
这里按 import 关系递归找出 bake_models.py 依赖的本地模块，要求它们都在那条 COPY 里。
"""
import ast
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"


def _local_imports(path: Path) -> set:
    """文件里 import 到的、src/ 下存在的模块文件名（含 try/except 里的相对与绝对两种写法）"""
    names = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.ImportFrom) and node.module:
            names.add(node.module.split(".")[0])
        elif isinstance(node, ast.Import):
            names.update(a.name.split(".")[0] for a in node.names)
    return {f"{n}.py" for n in names if (SRC / f"{n}.py").exists()}


def _closure(entry: str) -> set:
    seen, todo = set(), [entry]
    while todo:
        name = todo.pop()
        if name in seen:
            continue
        seen.add(name)
        todo.extend(_local_imports(SRC / name) - seen)
    return seen


@pytest.mark.parametrize("dockerfile", ["Dockerfile", "Dockerfile.gpu"])
def test_bake_step_copies_all_local_deps(dockerfile):
    text = (ROOT / dockerfile).read_text(encoding="utf-8")
    lines = text.splitlines()
    bake_idx = next(i for i, l in enumerate(lines) if l.startswith("RUN") and "bake_models.py" in l)
    copy_line = next(l for l in reversed(lines[:bake_idx]) if l.startswith("COPY"))
    copied = set(re.findall(r"apps/imaging-worker/src/([\w.]+\.py)", copy_line))
    missing = _closure("bake_models.py") - copied
    assert not missing, f"{dockerfile} 预热步骤缺少本地模块：{sorted(missing)}"

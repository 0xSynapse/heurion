"""影像服务的预期异常类型。

server.raise_http 只把这里的 InputError（以及 FileNotFoundError、ModelUnavailableError）当作
「调用方可以改正的问题」，原因如实转给平台；第三方库（numpy、nibabel、scipy 等）抛出的普通
ValueError 一律按内部错误处理（500 + 完整堆栈进日志），不再被误报成参数错误。
"""


class InputError(ValueError):
    """调用方输入不合法（缺参数、取值越界、影像不满足模型要求等）。

    message 必须是写给用户 / AI 看的中文说明，告诉对方怎么改；不要放内部异常原文。
    继承 ValueError，已有的 `except ValueError` / `pytest.raises(ValueError)` 照常生效。
    """

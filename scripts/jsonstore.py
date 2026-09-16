#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
jsonstore.py — `state/` 下 JSON 的读写底座：**原子写** + 把「还没有文件」与「文件坏了」分开

为什么需要它
------------
`state/` 下的 JSON 不是缓存，是**安全判据的载体**：`month_state.json` 是章程 L1-6 的分母，
`runtime.json` 是熔断与月度回撤的读数。它们此前都走最朴素的
`open(path, "w") + json.dump(...)`，而读方一律 `except Exception: 当作首次初始化`。
两个后果都不报错、都要人自己发现：

① **写不原子**。进程在 `json.dump` 写到一半时被杀、断电、磁盘满，会留下半截文件；
   `json.load` 抛 JSONDecodeError → 读方按「首次初始化」处理 → `month_peak_equity`
   被**静默重置成当前权益** → 真实回撤恒为 0 → **L1-6 熔断在当月剩余时间里再也触发不了**。
   而这条峰值是「只增不减、抬高一次不可逆」的：丢了就是丢了。
   注意这与已有的一条教训方向**相反**、危害同样是真金白银：峰值被**抬高**会让回撤虚高、
   误触发熔断（跨月首日看一眼看板就出过事）；被**悄悄清零**则让回撤虚低、该熔断不熔断。
   两条都得挡。

② **读方分不清「没有」与「坏了」**。文件不存在 = 新机器首次运行（正常，可以初始化）；
   文件存在但读不出来 = **数据没了**（要有人知道、要留证据）。混在一起处理，
   等于「悄悄把安全基准清零」。

本模块只做这两件事：

- `atomic_write_json()` —— 同目录临时文件 + `os.replace()`（同分区原子替换）；
  失败时不留半截文件、也不动原文件（原文件至少还是上一次的完整内容）。
- `read_json_state()` —— 返回 `(data, error)`：**文件不存在返回 `(None, None)`**，
  存在但读不出来返回 `(None, "原因")`。调用方必须显式处理 `error`，
  不许再用 `except: pass` 把它抹平。
"""

import json
import os
import tempfile


def atomic_write_json(path, data, *, indent=2):
    """原子写 JSON：同目录临时文件写满 → `os.replace()` 换名。

    为什么临时文件必须同目录：`os.replace()` 只在**同一文件系统**上才是原子的。
    写到系统临时目录（`%TEMP%` / `/tmp`）再 replace，跨分区时会退化成「复制 + 删除」，
    中途失败照样留半截文件。
    """
    d = os.path.dirname(os.path.abspath(path))
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix="." + os.path.basename(path) + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=indent)
            f.flush()
            # 先 fsync 再换名：否则断电后可能出现「名字是新的、内容还是空的」——
            # 换名是原子的，但内容有没有落盘是另一件事。
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        # 任何失败（对象序列化不了 / 磁盘满 / 被信号打断）都不许留下垃圾临时文件，
        # 更不许动原文件。注意这里连 KeyboardInterrupt 也一起收拾。
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return path


def read_json_state(path):
    """读一个「状态文件」。返回 `(data, error)`：

    - 文件不存在            → `(None, None)`   —— 首次运行，正常，调用方可以初始化
    - 存在但读不出来 / 顶层不是对象 → `(None, "原因")` —— **数据丢了**，必须让它可见
    - 正常                  → `(dict, None)`
    """
    if not os.path.exists(path):
        return None, None
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:  # noqa: BLE001 —— 坏文件的原因要原样带出去给调用方与用户看
        return None, "%s: %s" % (type(e).__name__, e)
    if not isinstance(data, dict):
        return None, "顶层不是对象（%s）" % type(data).__name__
    return data, None

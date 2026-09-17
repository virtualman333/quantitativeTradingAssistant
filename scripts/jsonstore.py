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
- `quarantine_broken()` —— 把读不出来的状态文件**原样留档**到 `.corrupt-<时间戳>`。
  这一步是给「数据丢了」留证据：坏文件本身是唯一的排查线索，被下一次写覆盖掉就找不回来了。
- `read_json_state_strict()` —— `read_json_state` 的严格版：读不出来就**抛异常**，
  供「读 → 改 → 写」的流程使用（见下）。

为什么还要一个严格版
--------------------
`read_json_state` 把「没有文件」与「文件坏了」分开了，但**分开之后怎么办**在每个调用方
各写一遍。而「读不出来就当空的、然后在它上面改、再写回去」这个错一旦写歪一次，
代价就是**现场被默认值覆盖**（本仓在 `runtime.json` 上已经栽过一次：
修好收尾那个写者之后，旁边那个每轮先跑的写者照样把坏现场洗成一份干净的合法文件）。

所以「坏了就中止本次写」这条**唯一安全的选择**做成一个不会写歪的入口：
调用方拿不到数据就只能中止，不存在「拿到一个默认值继续往下走」这条路。

顶层形状只能声明一次（`STATE_SHAPES`）
------------------------------------
`read_json_state` 要拿顶层类型当白名单，而**形状是文件自己的属性、不是调用方的属性**。
早先这件事靠调用方各传一份 `expect=`：`state/order_idem_<轮次>.json` 顶层是列表，
所以那一处传了 `expect=list`，其余走默认 `dict`。于是每新增一本账，就有一个**没人提醒的
必填参数**，而漏传的后果不是报错，是**把一份完好的文件判成「损坏」**：
`read_json_state` 返回 `(None, "顶层不是对象…")` → `month_risk` / `archive_round` 那条路
会顺手把它 `quarantine_broken()` 搬成 `.corrupt-*` → 峰值或幂等登记表被静默重置。
「判据要与文件的实际形状一致」这句话当时只写在 docstring 里，没有任何东西扛着它。

现在形状只在 `STATE_SHAPES` 里登记一次，`expected_shape()` 按路径查表：
调用方**不再传** `expect`（传了就直接报错 —— 与表一致也算第二处判据）；
查不到 = 未知路径 → 抛 `UnregisteredState`，**不猜**（猜成 `dict` 正是上面那条静默损坏）。
"""

import fnmatch
import json
import os
import tempfile

# 坏文件留档后缀：`month_state.json.corrupt-20260917-060000`
CORRUPT_SUFFIX = ".corrupt-"

# ── 顶层形状注册表：`state/` 下每个 JSON 的顶层是什么，**只在这里声明一次** ──────
#
# 为什么是「按文件名登记」而不是让调用方各传 `expect`：形状是文件的属性。
# 调用方各传一份的代价不是「多写一个参数」，而是**新增一本账时没人提醒**，
# 而漏传的默认值（`dict`）会把一份完好的列表判成「损坏」→ 被留档搬走 → 数据静默重置。
# 加新文件时**必须**来这里登记一行，否则 `UnregisteredState` 当场抛出来
# （`tests/stateshapes.test.ts` 另有一条对账：源码里读过的 state 文件与这张表必须互为子集）。
#
# 匹配按 `os.path.basename`，支持 `*` 通配（轮次文件名带轮次号）。
STATE_SHAPES = (
    ("month_state.json", dict),
    ("runtime.json", dict),
    ("reviewed_trades.json", dict),
    ("order_idem_*.json", list),
)


class StateUnreadable(Exception):
    """状态文件**存在但读不出来**（或顶层类型不对）—— 「读 → 改 → 写」必须就此中止。

    注意它与「文件不存在」是两件事：不存在 = 新机器首次运行，正常，可以初始化；
    抛这个异常 = **数据没了**，调用方不许拿默认值把它盖过去。
    """

    def __init__(self, path, error):
        super().__init__("%s: %s" % (path, error))
        self.path = path
        self.error = error


class UnregisteredState(Exception):
    """`state/` 下出现了一本**没有登记顶层形状**的账 —— 不知道形状就**不猜**。

    猜成 `dict` 会让「顶层是列表」的账被读成「损坏」，再被 `quarantine_broken()` 搬走。
    所以未知路径一律抛出来：调用方要么来 `STATE_SHAPES` 登记一行，要么显式说明它是什么。
    """

    def __init__(self, path):
        super().__init__(
            "%s 没有在 jsonstore.STATE_SHAPES 里登记顶层形状（不猜 —— 猜错会把完好文件判成损坏）"
            % os.path.basename(path))
        self.path = path


def expected_shape(path):
    """按文件名查出这本账的顶层形状。**唯一来源**，调用方不再各传一份。"""
    name = os.path.basename(path)
    for pattern, shape in STATE_SHAPES:
        if fnmatch.fnmatchcase(name, pattern):
            return shape
    raise UnregisteredState(path)


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


def read_json_state(path, expect=None):
    """读一个「状态文件」。返回 `(data, error)`：

    - 文件不存在            → `(None, None)`   —— 首次运行，正常，调用方可以初始化
    - 存在但读不出来 / 顶层不是 `expect` → `(None, "原因")` —— **数据丢了**，必须让它可见
    - 正常                  → `(data, None)`

    顶层形状由 `STATE_SHAPES` 按路径决定（`expected_shape()`）。调用方**不必也不该**
    自己传：传了就当场抛 `ValueError`（形状只能有一处判据，与表一致也算第二处）；
    未知路径抛 `UnregisteredState`（不猜 —— 猜成 `dict` 正是那类静默损坏的成因）。
    """
    declared = expected_shape(path)
    if expect is not None:
        raise ValueError(
            "%s 的顶层形状只在 jsonstore.STATE_SHAPES 里声明一次，调用方不该再传 expect（传的是 %s）"
            % (os.path.basename(path), getattr(expect, "__name__", expect)))
    expect = declared
    if not os.path.exists(path):
        return None, None
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:  # noqa: BLE001 —— 坏文件的原因要原样带出去给调用方与用户看
        return None, "%s: %s" % (type(e).__name__, e)
    if not isinstance(data, expect):
        return None, "顶层不是%s（%s）" % (
            {dict: "对象", list: "列表"}.get(expect, getattr(expect, "__name__", str(expect))),
            type(data).__name__)
    return data, None


def read_json_state_strict(path, expect=None, allow_missing=True):
    """`read_json_state` 的严格版：**读不出来就抛 `StateUnreadable`**。

    只有两个返回形态，调用方不需要判断 `error`：

    - 文件不存在且 `allow_missing=True` → 返回 `None`（调用方可以初始化一份）
    - 文件存在且读得出来              → 返回数据
    - 其余（存在但坏了 / 顶层类型不对 / `allow_missing=False` 时不存在）→ 抛 `StateUnreadable`

    「读 → 改 → 写」的流程必须走这个入口：拿不到数据就只能中止，
    `try/except: 当作空的` 这条路从签名上就不存在。
    """
    data, err = read_json_state(path, expect=expect)
    if err is not None:
        raise StateUnreadable(path, err)
    if data is None and not allow_missing:
        raise StateUnreadable(path, "文件不存在（本次要求它必须存在）")
    return data


def quarantine_broken(path, stamp):
    """把读不出来的状态文件**原样留档**到 `<path>.corrupt-<stamp>`，返回目标路径。

    用 `os.replace()`（同目录同分区，原子）而不是「复制 + 删除」：坏文件本身是排查线索，
    必须完整留档；复制再删的中间态下被杀，会同时留下半份副本和原文件。

    `stamp` 由调用方给（形如 `20260917-060000`），为了留档名一眼能看出是什么时候出的事。
    **同一 (path, stamp) 已存在时往后加序号，绝不覆盖** —— 留档是证据，
    第二份挤掉第一份就等于把最早那条线索毁掉。原子写都会坏，留档更不能。
    """
    dest = path + CORRUPT_SUFFIX + stamp
    n = 2
    while os.path.exists(dest):
        dest = "%s%s%s-%d" % (path, CORRUPT_SUFFIX, stamp, n)
        n += 1
    d = os.path.dirname(os.path.abspath(path))
    if d:
        os.makedirs(d, exist_ok=True)
    os.replace(path, dest)
    return dest

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
jin10_client.py — 金十数据财经 MCP 客户端（标准 MCP Streamable HTTP + Bearer Token）

严格按标准 MCP 流程接入：
    initialize -> notifications/initialized -> (tools/list | resources/list) -> tools/call

传输与鉴权：
  - 传输：Streamable HTTP（POST JSON-RPC；响应可为 application/json 或 text/event-stream）
  - 鉴权：Bearer Token（通过 Authorization 头，由 JIN10_MCP_TOKEN / --token 提供）
  - 会话：initialize 响应返回的 Mcp-Session-Id / mcp-protocol-version 头需回传
  - 推荐协议版本：2025-11-25（握手失败自动回退到其它已知版本）

结果读取约定（与金十服务一致）：
  - 优先使用 result.structuredContent（机器解析主源）
  - result.content 仅作为可读文本补充（_text 字段），不作主要解析来源

分页约定（本服务统一，不要传 offset）：
  - 请求参数：cursor
  - 响应字段：data.next_cursor
  - 是否还有更多：data.has_more

用法：
  # 列出工具 / 资源
  python scripts/jin10_client.py --list-tools
  python scripts/jin10_client.py --list-resources

  # 行情 / K线（先确认 code 再调用）
  python scripts/jin10_client.py --quote-codes
  python scripts/jin10_client.py --quote XAUUSD
  python scripts/jin10_client.py --kline XAUUSD --count 10

  # 快讯
  python scripts/jin10_client.py --flash --all           # 顺序浏览最新流
  python scripts/jin10_client.py --search-flash 黄金      # 关键词搜索

  # 资讯
  python scripts/jin10_client.py --news --all
  python scripts/jin10_client.py --search-news 美联储
  python scripts/jin10_client.py --news-detail <id>

  # 财经日历
  python scripts/jin10_client.py --calendar

  # 任意工具透传
  python scripts/jin10_client.py --call get_kline --args '{"code":"XAGUSD","count":5}'

  # 资源读取
  python scripts/jin10_client.py --read-resource quote://codes
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

# ---------------------------------------------------------------------------
# 配置默认值
# ---------------------------------------------------------------------------
DEFAULT_SERVER_URL = "https://mcp.jin10.com/mcp"
DEFAULT_PROTOCOL = "2025-11-25"
# 握手失败时的回退协议版本（按常见版本排列）
FALLBACK_PROTOCOLS = ["2024-11-05", "2025-06-18", "2025-03-26"]
# 默认 Token：可用环境变量 JIN10_MCP_TOKEN 或 --token 覆盖（推荐放环境变量，勿入库）
DEFAULT_TOKEN = "sk-R7V5Q69CqBwTmuX52qmdO0qnH_CgsCdT9cAV96LZ4I4"

# 金十限流错误提示（来自服务约定）
RATE_LIMIT_MSG = "今日该工具调用次数已达上限，请明日再试"


class McpError(Exception):
    """JSON-RPC / 协议层错误。"""


class Jin10MCPClient:
    def __init__(self, server_url=DEFAULT_SERVER_URL, token=None,
                 protocol=None, timeout=30):
        self.server_url = server_url.rstrip("/")
        self.token = (token or os.environ.get("JIN10_MCP_TOKEN")
                      or DEFAULT_TOKEN)
        self.protocol = (protocol or os.environ.get("JIN10_MCP_PROTOCOL")
                         or DEFAULT_PROTOCOL)
        self.timeout = timeout
        self.session_id = None
        self.server_protocol = None
        self._id = 0
        self._initialized = False

    # ------------------------------------------------------------------ 底层
    def _headers(self, accept="application/json, text/event-stream"):
        h = {
            "Content-Type": "application/json",
            "Accept": accept,
            "Authorization": "Bearer " + self.token,
            "User-Agent": "okx-trader-jin10/1.0",
        }
        if self.session_id:
            h["Mcp-Session-Id"] = self.session_id
        if self.server_protocol:
            h["mcp-protocol-version"] = self.server_protocol
        return h

    def _next(self, method, params):
        self._id += 1
        msg = {"jsonrpc": "2.0", "id": self._id, "method": method}
        if params is not None:
            msg["params"] = params
        return msg, self._id

    @staticmethod
    def _find(msgs, rid):
        for m in msgs:
            if isinstance(m, dict) and m.get("id") == rid and \
               ("result" in m or "error" in m):
                return m
        return None

    def _post(self, payload):
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(self.server_url, data=data, method="POST")
        for k, v in self._headers().items():
            req.add_header(k, v)
        try:
            resp = urllib.request.urlopen(req, timeout=self.timeout)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            raise McpError("HTTP %s: %s" % (e.code, body[:500]))
        except urllib.error.URLError as e:
            raise McpError("网络错误: %s" % e.reason)
        ct = resp.headers.get("Content-Type", "")
        sid = resp.headers.get("Mcp-Session-Id")
        sp = resp.headers.get("mcp-protocol-version")
        if sid:
            self.session_id = sid
        if sp:
            self.server_protocol = sp
        raw = resp.read()
        return resp.status, ct, raw

    def _get_req(self):
        req = urllib.request.Request(self.server_url, method="GET")
        for k, v in self._headers(accept="text/event-stream").items():
            req.add_header(k, v)
        return req

    @staticmethod
    def _read_sse_lines(resp, want_id):
        """增量解析 SSE 行流，找到匹配 want_id 的消息即返回。"""
        data_lines = []
        found = None
        for raw_line in resp:
            line = raw_line.decode("utf-8", "replace").rstrip("\r\n")
            if line == "":
                if data_lines:
                    payload = "\n".join(data_lines)
                    try:
                        msg = json.loads(payload)
                    except json.JSONDecodeError:
                        msg = None
                    if isinstance(msg, dict) and msg.get("id") == want_id:
                        found = msg
                        break
                data_lines = []
                continue
            if line.startswith(":"):
                continue
            if line.startswith("event:"):
                continue
            if line.startswith("data:"):
                data_lines.append(line[len("data:"):].lstrip())
        if found is None and data_lines:
            try:
                msg = json.loads("\n".join(data_lines))
            except json.JSONDecodeError:
                msg = None
            if isinstance(msg, dict) and msg.get("id") == want_id:
                found = msg
        return found

    def _rpc(self, method, params=None, expect_response=True, retries=2):
        payload, rid = self._next(method, params)
        last_err = None
        for attempt in range(retries + 1):
            try:
                status, ct, raw = self._post(payload)
            except McpError as e:
                last_err = e
                if attempt < retries:
                    time.sleep(0.3 * (attempt + 1))
                    continue
                raise
            msg = None
            if raw:
                text = raw.decode("utf-8", "replace")
                if "text/event-stream" in ct:
                    from_sse = self._find(_parse_sse_block(text), rid)
                    msg = from_sse
                else:
                    try:
                        cand = json.loads(text)
                        if isinstance(cand, dict) and cand.get("id") == rid:
                            msg = cand
                    except json.JSONDecodeError:
                        msg = self._find(_parse_sse_block(text), rid)
            if msg is not None:
                return self._check(msg)
            # 202 / 空响应：尝试用 GET 拉取挂起的响应（Streamable HTTP 反向通道）
            if expect_response and status in (200, 202):
                try:
                    g = urllib.request.urlopen(self._get_req(),
                                               timeout=self.timeout)
                    msg = self._read_sse_lines(g, rid)
                    g.close()
                except Exception:
                    msg = None
                if msg is not None:
                    return self._check(msg)
            if not expect_response:
                return None
            if attempt < retries:
                time.sleep(0.3 * (attempt + 1))
                continue
            raise McpError("未收到 id=%s 的响应（status=%s, ct=%s, body=%s）"
                           % (rid, status, ct,
                              (raw or b"")[:200].decode("utf-8", "replace")))
        if last_err:
            raise last_err
        raise McpError("未知握手失败")

    @staticmethod
    def _check(msg):
        if "error" in msg:
            err = msg["error"]
            raise McpError("JSON-RPC error %s: %s"
                           % (err.get("code"), err.get("message", "")))
        return msg.get("result")

    # -------------------------------------------------------------- 握手流程
    def initialize(self):
        if self._initialized:
            return
        protocols = [self.protocol] + [p for p in FALLBACK_PROTOCOLS
                                       if p != self.protocol]
        last_err = None
        for proto in protocols:
            try:
                result = self._rpc("initialize", {
                    "protocolVersion": proto,
                    "capabilities": {},
                    "clientInfo": {"name": "okx-trader-jin10", "version": "1.0"},
                })
                if isinstance(result, dict):
                    self.server_protocol = result.get("protocolVersion", proto)
                self._initialized = True
                # 发送 initialized 通知（无需响应）
                try:
                    self._rpc("notifications/initialized", expect_response=False)
                except Exception:
                    pass
                return
            except McpError as e:
                last_err = e
                # 协议版本被拒时回退；其它错误也尝试下一版本（成本低）
                continue
        raise McpError("initialize 失败: %s" % last_err)

    # ---------------------------------------------------------- 高层封装方法
    def list_tools(self):
        self.initialize()
        return self._rpc("tools/list", {}).get("tools", [])

    def list_resources(self):
        self.initialize()
        return self._rpc("resources/list", {}).get("resources", [])

    def call_tool(self, name, arguments=None):
        self.initialize()
        result = self._rpc("tools/call",
                           {"name": name, "arguments": arguments or {}})
        return self._normalize_result(result)

    def read_resource(self, uri):
        self.initialize()
        result = self._rpc("resources/read", {"uri": uri})
        return self._normalize_result(result)

    @staticmethod
    def _normalize_result(result):
        """把 MCP tool/resource 结果规范为统一信封。

        返回: {"structured": <structuredContent | None>,
               "isError": <bool>,
               "text": <可读文本补充 | None>}
        """
        if not isinstance(result, dict):
            return {"structured": result, "isError": False, "text": None}
        is_error = bool(result.get("isError", False))
        structured = result.get("structuredContent")
        text = None
        # tools/call 结果：content 为 [{type:"text", text:"..."}]
        content = result.get("content")
        if isinstance(content, list):
            parts = []
            for c in content:
                if isinstance(c, dict) and c.get("type") == "text":
                    parts.append(c.get("text", ""))
            text = "\n".join(parts) if parts else None
        # resources/read 结果：contents 为 [{uri, mimeType, text:"..."}]
        # （金十资源走此分支，工具走上面的 content 分支）
        if text is None:
            contents = result.get("contents")
            if isinstance(contents, list):
                parts = []
                for c in contents:
                    if isinstance(c, dict) and c.get("text"):
                        parts.append(c.get("text"))
                text = "\n".join(parts) if parts else None
        return {"structured": structured, "isError": is_error, "text": text}

    # ---------------------------------------------------------- 业务便捷方法
    def get_quote(self, code):
        return self.call_tool("get_quote", {"code": code})

    def get_kline(self, code, time=None, count=None):
        args = {"code": code}
        if time is not None:
            args["time"] = time
        if count is not None:
            args["count"] = count
        return self.call_tool("get_kline", args)

    def list_flash(self, cursor=None):
        args = {}
        if cursor is not None:
            args["cursor"] = cursor
        return self.call_tool("list_flash", args)

    def search_flash(self, keyword, cursor=None):
        args = {"keyword": keyword}
        if cursor is not None:
            args["cursor"] = cursor
        return self.call_tool("search_flash", args)

    def list_news(self, cursor=None):
        args = {}
        if cursor is not None:
            args["cursor"] = cursor
        return self.call_tool("list_news", args)

    def search_news(self, keyword, cursor=None):
        args = {"keyword": keyword}
        if cursor is not None:
            args["cursor"] = cursor
        return self.call_tool("search_news", args)

    def get_news(self, news_id):
        return self.call_tool("get_news", {"id": news_id})

    def list_calendar(self):
        return self.call_tool("list_calendar", {})

    def list_quote_codes(self):
        return self.read_resource("quote://codes")

    # -------------------------------------------------- 自动翻页（cursor 链）
    def paginate_list(self, tool, base_args=None, max_pages=None):
        """对 list_*/search_* 类工具按 cursor 自动翻页并合并 items。

        注意：金十返回结构为 {..., "data": {"items":[...], "next_cursor":.., "has_more":..}}
        分页字段实际挂在 data 下，这里统一从这里取。
        """
        items, cursor, pages, has_more = [], None, 0, True
        while has_more and (max_pages is None or pages < max_pages):
            args = dict(base_args or {})
            if cursor is not None:
                args["cursor"] = cursor
            norm = self.call_tool(tool, args)
            if norm["isError"]:
                return norm
            top = norm["structured"] if isinstance(norm["structured"], dict) else {}
            data = top.get("data") if isinstance(top.get("data"), dict) else top
            items.extend(data.get("items", []))
            cursor = data.get("next_cursor")
            has_more = bool(data.get("has_more"))
            pages += 1
        return {"isError": False,
                "structured": {"data": {"items": items, "next_cursor": cursor,
                                        "has_more": False},
                               "pages": pages},
                "text": None}


def _parse_sse_block(text):
    """把一段 SSE 文本解析为 JSON-RPC 消息列表。"""
    msgs, data_lines = [], []
    for line in text.splitlines():
        if line == "":
            if data_lines:
                try:
                    msgs.append(json.loads("\n".join(data_lines)))
                except json.JSONDecodeError:
                    pass
            data_lines = []
            continue
        if line.startswith(":"):
            continue
        if line.startswith("data:"):
            data_lines.append(line[len("data:"):].lstrip())
    if data_lines:
        try:
            msgs.append(json.loads("\n".join(data_lines)))
        except json.JSONDecodeError:
            pass
    return msgs


def emit(obj, compact=False):
    """输出统一信封并决定退出码。"""
    if compact:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False))
        sys.stdout.write("\n")
    else:
        print(json.dumps(obj, ensure_ascii=False, indent=2))
    return 0 if (obj.get("ok") is True and not obj.get("isError")) else 1


def build_envelope(norm):
    """把 _normalize_result 的输出包装成 CLI 信封。"""
    is_error = norm.get("isError", False)
    text = norm.get("text")
    rate_limited = bool(text and RATE_LIMIT_MSG in text)
    structured = norm.get("structured")
    # 优先 structured；为空时回退到 text（若 text 本身是 JSON 则解析）
    result = structured
    if result is None and text:
        try:
            result = json.loads(text)
        except (json.JSONDecodeError, TypeError):
            result = text
    return {
        "ok": not is_error,
        "isError": is_error,
        "rate_limited": rate_limited,
        "result": result,
        "text": text,
    }


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="金十数据财经 MCP 客户端（标准 Streamable HTTP + Bearer）")
    ap.add_argument("--server", default=DEFAULT_SERVER_URL)
    ap.add_argument("--token", default=None, help="Bearer Token（默认读 JIN10_MCP_TOKEN）")
    ap.add_argument("--protocol", default=None, help="协议版本（默认 2025-11-25）")
    ap.add_argument("--timeout", type=int, default=30)

    ap.add_argument("--list-tools", action="store_true")
    ap.add_argument("--list-resources", action="store_true")
    ap.add_argument("--read-resource", metavar="URI", default=None)
    ap.add_argument("--call", metavar="TOOL", default=None, help="透传调用工具名")
    ap.add_argument("--args", default="{}", help="JSON 参数对象")

    ap.add_argument("--quote", metavar="CODE", default=None)
    ap.add_argument("--kline", metavar="CODE", default=None)
    ap.add_argument("--time", default=None)
    ap.add_argument("--count", type=int, default=None)

    ap.add_argument("--flash", action="store_true")
    ap.add_argument("--search-flash", metavar="KEYWORD", default=None)
    ap.add_argument("--news", action="store_true")
    ap.add_argument("--search-news", metavar="KEYWORD", default=None)
    ap.add_argument("--news-detail", metavar="ID", default=None)
    ap.add_argument("--calendar", action="store_true")
    ap.add_argument("--quote-codes", action="store_true")

    ap.add_argument("--cursor", default=None)
    ap.add_argument("--all", action="store_true", help="自动翻页直到 has_more=false")
    ap.add_argument("--pages", type=int, default=None, help="最多翻页数")
    ap.add_argument("--compact", action="store_true", help="紧凑 JSON 输出（单行）")

    a = ap.parse_args(argv)
    client = Jin10MCPClient(server_url=a.server, token=a.token,
                            protocol=a.protocol, timeout=a.timeout)

    try:
        # 列表/资源类
        if a.list_tools:
            tools = client.list_tools()
            return emit({"ok": True, "tools": [
                {"name": t.get("name"), "description": (t.get("description") or "")[:120]}
                for t in tools]})
        if a.list_resources:
            res = client.list_resources()
            return emit({"ok": True, "resources": [
                {"uri": r.get("uri"), "name": r.get("name"),
                 "description": (r.get("description") or "")[:120]}
                for r in res]})
        if a.read_resource:
            return emit(build_envelope(client.read_resource(a.read_resource)))
        if a.quote_codes:
            return emit(build_envelope(client.list_quote_codes()))

        # 透传
        if a.call:
            args = json.loads(a.args) if a.args else {}
            return emit(build_envelope(client.call_tool(a.call, args)))

        # 行情 / K线
        if a.quote:
            return emit(build_envelope(client.get_quote(a.quote)))
        if a.kline:
            return emit(build_envelope(client.get_kline(a.kline, a.time, a.count)))

        # 快讯
        if a.flash:
            if a.all or a.pages:
                return emit(build_envelope(
                    client.paginate_list("list_flash", {}, a.pages)))
            return emit(build_envelope(client.list_flash(a.cursor)))
        if a.search_flash is not None:
            if a.all or a.pages:
                return emit(build_envelope(
                    client.paginate_list("search_flash",
                                         {"keyword": a.search_flash}, a.pages)))
            return emit(build_envelope(client.search_flash(a.search_flash, a.cursor)))

        # 资讯
        if a.news:
            if a.all or a.pages:
                return emit(build_envelope(
                    client.paginate_list("list_news", {}, a.pages)))
            return emit(build_envelope(client.list_news(a.cursor)))
        if a.search_news is not None:
            if a.all or a.pages:
                return emit(build_envelope(
                    client.paginate_list("search_news",
                                         {"keyword": a.search_news}, a.pages)))
            return emit(build_envelope(client.search_news(a.search_news, a.cursor)))
        if a.news_detail:
            return emit(build_envelope(client.get_news(a.news_detail)))

        # 财经日历
        if a.calendar:
            return emit(build_envelope(client.list_calendar()))

        ap.print_help()
        return 2
    except McpError as e:
        return emit({"ok": False, "error": str(e)})
    except Exception as e:  # 兜底，避免抛出未处理异常
        return emit({"ok": False, "error": "%s: %s" % (type(e).__name__, e)})


if __name__ == "__main__":
    sys.exit(main())

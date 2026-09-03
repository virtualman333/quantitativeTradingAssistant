#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mail_send.py — 邮件投递降级通道（QQ 邮箱 MCP 连接器不可用时使用）

首选通道是 `mcp__qq-mail__SendMessage`（章程 §12.2）。当该连接器在当前会话未启用
（~/.workbuddy/connectors/default/mcp.json 中 connector:qq-mail 为 disabled）时，
本脚本通过 SMTP 直连投递，保证「每轮必发」不中断。

复用用户已有的发信凭据（与 ETH 播报自动化同一套 SMTP 配置）。

⚠ 凭据不入库（2026-09-02 起）：SMTP 密码曾以明文硬编码在本文件，随仓库公开会泄露邮箱授权码。
现按以下优先级读取，两者均不进 git：
  1. 环境变量：OKX_MAIL_SMTP_PASSWORD（可选覆盖 HOST/PORT/USER/SENDER/TO）
  2. 本地未跟踪文件：scripts/.smtp_local.json（模板见 .smtp_local.json.example）

用法：
  python scripts/mail_send.py --in state/mail_out.json
  python scripts/mail_send.py --in state/mail_out.json --to other@example.com

退出码：0 成功 / 1 失败（调用方负责重试一次，仍失败则记录到 DASHBOARD，不回滚交易）
"""
import argparse
import json
import os
import smtplib
import sys
from email.header import Header
from email.mime.text import MIMEText

# 非敏感默认值（可入库）；密码单独在 _load_smtp_cred() 中读取
DEFAULT_HOST = "smtp.yeah.net"
DEFAULT_PORT = 465
DEFAULT_USER = "unitokenhub@yeah.net"
DEFAULT_SENDER = "unitokenhub@yeah.net"
DEFAULT_TO = "virtualman@vip.qq.com"

LOCAL_CRED_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), ".smtp_local.json")


def _load_smtp_cred():
    """读取 SMTP 凭据。优先级：环境变量 > scripts/.smtp_local.json。

    返回 dict(host, port, user, password, sender, to)；缺密码时返回 None。
    两个来源都不在版本控制内 —— 任何把密码写回本文件的改动都是安全回退。
    """
    env = os.environ.get
    cred = {
        "host": env("OKX_MAIL_SMTP_HOST", DEFAULT_HOST),
        "port": int(env("OKX_MAIL_SMTP_PORT", DEFAULT_PORT)),
        "user": env("OKX_MAIL_SMTP_USER", DEFAULT_USER),
        "password": env("OKX_MAIL_SMTP_PASSWORD", ""),
        "sender": env("OKX_MAIL_SMTP_SENDER", DEFAULT_SENDER),
        "to": env("OKX_MAIL_TO", DEFAULT_TO),
    }

    if not cred["password"] and os.path.exists(LOCAL_CRED_FILE):
        try:
            with open(LOCAL_CRED_FILE, "r", encoding="utf-8") as f:
                j = json.load(f)
        except Exception as e:
            print("SMTP_CRED_READ_FAILED: %s: %s" % (LOCAL_CRED_FILE, e))
            return None
        for k in ("host", "user", "password", "sender", "to"):
            if j.get(k):
                cred[k] = j[k]
        if j.get("port"):
            cred["port"] = int(j["port"])

    if not cred["password"]:
        print("SMTP_PASSWORD_MISSING: 未找到发信密码。请设置环境变量 "
              "OKX_MAIL_SMTP_PASSWORD，或按 .smtp_local.json.example 创建 "
              "scripts/.smtp_local.json（该文件已在 .gitignore 中）。")
        return None
    return cred


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True,
                    help="mail_report.py 渲染出的 mail_out.json")
    ap.add_argument("--to", default=None, help="覆盖收件人，逗号分隔")
    a = ap.parse_args()

    with open(a.inp, "r", encoding="utf-8") as f:
        d = json.load(f)

    subject = d.get("subject") or "(no subject)"
    body = d.get("body") or ""
    cred = _load_smtp_cred()
    if cred is None:
        return 1

    to = a.to or (", ".join(d["to"]) if isinstance(d.get("to"), list)
                  else (d.get("to") or cred["to"]))
    recipients = [x.strip() for x in to.split(",") if x.strip()]

    fmt = (d.get("body_format") or "PLAIN").upper()
    subtype = "html" if fmt == "HTML" else "plain"

    msg = MIMEText(body, subtype, "utf-8")
    msg["Subject"] = Header(subject, "utf-8")
    msg["From"] = cred["sender"]
    msg["To"] = ", ".join(recipients)

    try:
        server = smtplib.SMTP_SSL(cred["host"], cred["port"], timeout=30)
        server.login(cred["user"], cred["password"])
        server.sendmail(cred["sender"], recipients, msg.as_string())
        server.quit()
    except Exception as e:
        print("EMAIL_SEND_FAILED: %s: %s" % (type(e).__name__, e))
        return 1

    print("EMAIL_SENT_OK to %s | subject=%s | chars=%d"
          % (", ".join(recipients), subject, len(body)))
    return 0


if __name__ == "__main__":
    sys.exit(main())

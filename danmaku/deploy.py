#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 B站弹幕网关部署到服务器（Docker 方式）。

它会：
  1. 上传 gateway.py 与 Dockerfile 到服务器
  2. docker build 出镜像 danmaku-gateway
  3. 用 --restart unless-stopped 重建容器并映射 8099 端口
  4. 调用 /health 做一次自检，并打印最近日志

依赖： pip install paramiko

用法（Windows PowerShell）：
    $env:SSH_PASS='你的SSH密码'
    python deploy.py

可选环境变量：
    SSH_HOST        服务器地址，默认 43.139.182.16
    SSH_PORT        SSH 端口，默认 22
    SSH_USER        SSH 用户，默认 root
    SSH_PASS        SSH 密码（必填）
    DANMAKU_PORT    网关端口，默认 8099
    DANMAKU_NAME    容器名，默认 danmaku-gateway
    DANMAKU_COOKIE  B站登录 Cookie（可选）
"""

import os
import sys

try:
    import paramiko
except ImportError:
    sys.exit("缺少依赖 paramiko，请先执行： pip install paramiko")

LOCAL_DIR = os.path.dirname(os.path.abspath(__file__))
HOST = os.environ.get("SSH_HOST", "43.139.182.16")
PORT = int(os.environ.get("SSH_PORT", "22"))
USER = os.environ.get("SSH_USER", "root")
PASSWORD = os.environ.get("SSH_PASS", "")
GW_PORT = os.environ.get("DANMAKU_PORT", "8099")
NAME = os.environ.get("DANMAKU_NAME", "danmaku-gateway")
# 可选：登录 Cookie（浏览器里复制的 "SESSDATA=...; bili_jct=...; DedeUserID=..."）。
# 带上后弹幕昵称才是真实昵称；不传则保持匿名（昵称显示为 ***）。
COOKIE = os.environ.get("DANMAKU_COOKIE", "").strip()

REMOTE_DIR = "/opt/danmaku-src"
IMAGE = "danmaku-gateway:latest"
FILES = ["gateway.py", "Dockerfile"]


def main():
    if not PASSWORD:
        sys.exit("请先设置环境变量 ZLM_SSH_PASS 为 SSH 密码")

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(HOST, port=PORT, username=USER, password=PASSWORD,
                       timeout=15, banner_timeout=20, auth_timeout=20,
                       look_for_keys=False, allow_agent=False)
    except Exception as exc:
        sys.exit("SSH 连接失败：" + str(exc))

    def run(cmd, timeout=600, quiet=False):
        if not quiet:
            print("$ " + cmd)
        _in, out, err = client.exec_command(cmd, timeout=timeout)
        stdout = out.read().decode("utf-8", "replace").rstrip()
        stderr = err.read().decode("utf-8", "replace").rstrip()
        code = out.channel.recv_exit_status()
        if stdout and not quiet:
            print(stdout)
        if stderr and not quiet:
            print("[stderr] " + stderr)
        return code, stdout + "\n" + stderr

    print("已连接 %s" % HOST)

    # 1. 上传源码
    run("mkdir -p " + REMOTE_DIR)
    sftp = client.open_sftp()
    for name in FILES:
        local = os.path.join(LOCAL_DIR, name)
        if not os.path.exists(local):
            sys.exit("缺少文件：" + local)
        sftp.put(local, REMOTE_DIR + "/" + name)
        print("已上传 " + name)
    sftp.close()

    # 2. 构建镜像
    print("\n开始构建镜像（首次需要拉取 python 基础镜像，会慢一些）…")
    code, output = run("docker build -t " + IMAGE + " " + REMOTE_DIR)
    if code != 0:
        sys.exit("镜像构建失败，请检查上面的输出")

    # 3. 重建容器
    run("docker rm -f " + NAME + " 2>/dev/null || true")
    env_arg = ""
    if COOKIE:
        env_arg = " -e DANMAKU_COOKIE='%s'" % COOKIE.replace("'", "'\\''")
    run("docker run -d --name %s --restart unless-stopped -p %s:%s%s %s"
        % (NAME, GW_PORT, GW_PORT, env_arg, IMAGE))
    print("登录 Cookie：%s" % ("已注入" if COOKIE else "未注入（弹幕昵称会显示为 ***）"))

    # 4. 自检
    import time
    time.sleep(3)
    print("\n" + "=" * 64)
    code, health = run("curl -s --max-time 8 http://127.0.0.1:%s/health" % GW_PORT)
    print("=" * 64)
    run("docker ps --filter name=%s --format '{{.Names}} | {{.Status}} | {{.Ports}}'" % NAME)
    print("=" * 64)
    run("docker logs --tail 25 %s" % NAME)

    client.close()

    ok = '"ok"' in health
    print("\n" + ("部署完成，网关健康检查通过。" if ok else "部署完成，但健康检查未通过，请看上面的日志。"))
    print("导播台里填写的网关地址： ws://%s:%s/danmaku" % (HOST, GW_PORT))


if __name__ == "__main__":
    main()

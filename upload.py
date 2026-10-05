#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把改动过的静态文件上传到 director-web 服务器。

目标：43.139.182.16 的 /opt/director-web/ （nginx 容器 director-web 挂载）
用法：
    $env:SSH_PASS='你的SSH密码'
    python upload.py index.html css/style.css
"""
import os
import sys

import paramiko

HOST = os.environ.get("SSH_HOST", "43.139.182.16")
USER = os.environ.get("SSH_USER", "root")
PASSWORD = os.environ.get("SSH_PASS", "")
REMOTE_DIR = "/opt/director-web"

PROJECT = os.path.dirname(os.path.abspath(__file__))


def main():
    if not PASSWORD:
        sys.exit("请设置环境变量 SSH_PASS")
    files = sys.argv[1:] or ["index.html", "css/style.css"]

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=PASSWORD, timeout=15,
                   look_for_keys=False, allow_agent=False)
    sftp = client.open_sftp()

    for rel in files:
        local = os.path.join(PROJECT, rel)
        remote = REMOTE_DIR + "/" + rel.replace("\\", "/")
        sftp.put(local, remote)
        print("已上传 -> " + remote)

    sftp.close()
    client.close()
    print("上传完成")


if __name__ == "__main__":
    main()

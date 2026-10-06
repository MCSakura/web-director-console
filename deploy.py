#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
网页导播台 · 一键部署脚本（交互式 / 命令行参数两种模式）

部署目标（服务器 43.139.182.16）：
  1. 导播台前端  -> /opt/director-web/        （nginx 容器 director-web，端口 80）
  2. B站弹幕网关 -> /opt/danmaku-src/         （Docker 容器 danmaku-gateway，端口 8099）

==================== 用法 ====================

【交互模式】直接运行，按菜单选择：
    python deploy.py

【命令行模式】适合 CI / 一键批处理：
    python deploy.py all          # 全部部署（前端 + 弹幕网关）
    python deploy.py web          # 只部署导播台前端
    python deploy.py danmaku      # 只部署弹幕网关
    python deploy.py upload f1 f2 # 增量上传指定文件（相对项目根目录）
    python deploy.py status       # 查看服务器运行状态
    python deploy.py -h           # 显示帮助

==================== 环境变量 ====================

    SSH_HOST   服务器地址，默认 43.139.182.16
    SSH_PORT   SSH 端口，默认 22
    SSH_USER   SSH 用户，默认 root
    SSH_PASS   SSH 密码（交互模式下未设置时会提示输入）
    DANMAKU_COOKIE  可选：B站登录 Cookie，注入弹幕网关以显示真实昵称

Windows PowerShell 示例：
    $env:SSH_PASS='你的密码'
    python deploy.py all
"""
import io
import os
import sys
import time
import getpass
import tarfile
import zipfile

try:
    import paramiko
except ImportError:
    sys.exit("缺少依赖 paramiko，请先执行： pip install paramiko")

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))

HOST = os.environ.get("SSH_HOST", "43.139.182.16")
PORT = int(os.environ.get("SSH_PORT", "22"))
USER = os.environ.get("SSH_USER", "root")
PASSWORD = os.environ.get("SSH_PASS", "")
COOKIE = os.environ.get("DANMAKU_COOKIE", "").strip()

# 前端部署
WEB_REMOTE = "/opt/director-web"
WEB_FILES = ["index.html", "pgm.html", "css", "js"]

# 弹幕网关部署
DM_LOCAL = os.path.join(PROJECT_DIR, "danmaku")
DM_REMOTE = "/opt/danmaku-src"
DM_IMAGE = "danmaku-gateway:latest"
DM_NAME = os.environ.get("DANMAKU_NAME", "danmaku-gateway")
DM_PORT = os.environ.get("DANMAKU_PORT", "8099")
DM_FILES = ["gateway.py", "Dockerfile"]

SEP = "=" * 64


def connect():
    """建立 SSH 连接，密码未设置时交互提示输入。"""
    global PASSWORD
    if not PASSWORD:
        try:
            PASSWORD = getpass.getpass("请输入 SSH 密码（%s@%s）：" % (USER, HOST))
        except (EOFError, KeyboardInterrupt):
            sys.exit("\n已取消")
        if not PASSWORD:
            sys.exit("密码不能为空")

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(HOST, port=PORT, username=USER, password=PASSWORD,
                       timeout=15, banner_timeout=20, auth_timeout=20,
                       look_for_keys=False, allow_agent=False)
    except Exception as exc:
        sys.exit("SSH 连接失败：" + str(exc))
    return client


def run(client, cmd, timeout=600, quiet=False, echo=True):
    if echo and not quiet:
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


# ==================== 前端部署 ====================

def build_web_tar():
    """把前端文件打包，HTML 注入 ?v=时间戳 绕过缓存。"""
    import re
    stamp = str(int(time.time()))
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name in WEB_FILES:
            path = os.path.join(PROJECT_DIR, name)
            if not os.path.exists(path):
                sys.exit("缺少文件：" + path)
            if name.lower().endswith(".html"):
                with open(path, "r", encoding="utf-8") as fh:
                    html = fh.read()
                html = re.sub(r'(href="[^"?]+\.css)"', r'\1?v=' + stamp + '"', html)
                html = re.sub(r'(src="[^"?]+\.js)"', r'\1?v=' + stamp + '"', html)
                data = html.encode("utf-8")
                info = tarfile.TarInfo(name)
                info.size = len(data)
                info.mtime = int(time.time())
                tar.addfile(info, io.BytesIO(data))
            else:
                tar.add(path, arcname=name)
    buf.seek(0)
    return buf


def build_pkg_tar():
    """
    构建可供 install.sh 下载的部署包 director-console.tar.gz。
    结构：
      web/        前端文件（index.html, pgm.html, css/, js/）
      danmaku/    弹幕网关（gateway.py, Dockerfile）
    """
    import re
    stamp = str(int(time.time()))
    buf = io.BytesIO()

    def add_tree(tar, local_dir, arc_dir):
        for root, _dirs, files in os.walk(local_dir):
            for fn in files:
                full = os.path.join(root, fn)
                rel = os.path.relpath(full, local_dir).replace("\\", "/")
                arc = arc_dir + "/" + rel
                if fn.lower().endswith(".html"):
                    with open(full, "r", encoding="utf-8") as fh:
                        html = fh.read()
                    html = re.sub(r'(href="[^"?]+\.css)"', r'\1?v=' + stamp + '"', html)
                    html = re.sub(r'(src="[^"?]+\.js)"', r'\1?v=' + stamp + '"', html)
                    data = html.encode("utf-8")
                    info = tarfile.TarInfo(arc)
                    info.size = len(data)
                    info.mtime = int(time.time())
                    tar.addfile(info, io.BytesIO(data))
                else:
                    tar.add(full, arcname=arc)

    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        # 前端
        for name in WEB_FILES:
            path = os.path.join(PROJECT_DIR, name)
            if not os.path.exists(path):
                sys.exit("缺少文件：" + path)
            if os.path.isdir(path):
                add_tree(tar, path, "web/" + name)
            else:
                if name.lower().endswith(".html"):
                    with open(path, "r", encoding="utf-8") as fh:
                        html = fh.read()
                    html = re.sub(r'(href="[^"?]+\.css)"', r'\1?v=' + stamp + '"', html)
                    html = re.sub(r'(src="[^"?]+\.js)"', r'\1?v=' + stamp + '"', html)
                    data = html.encode("utf-8")
                    info = tarfile.TarInfo("web/" + name)
                    info.size = len(data)
                    info.mtime = int(time.time())
                    tar.addfile(info, io.BytesIO(data))
                else:
                    tar.add(path, arcname="web/" + name)
        # 弹幕网关
        for name in DM_FILES:
            path = os.path.join(DM_LOCAL, name)
            if not os.path.exists(path):
                sys.exit("缺少文件：" + path)
            tar.add(path, arcname="danmaku/" + name)

    buf.seek(0)
    return buf


def make_zip_package():
    """
    把静态站点打包成 director-web.zip（index.html 在压缩包根目录）。
    用于 1Panel / 宝塔 这类面板：在面板里建好站点后，把 zip 传到网站根目录解压即可。
    这个命令不连服务器。
    """
    import re
    stamp = str(int(time.time()))

    def html_bytes(path):
        with open(path, "r", encoding="utf-8") as fh:
            html = fh.read()
        # 注入 ?v=时间戳，避免面板/CDN 缓存住旧版 js/css
        html = re.sub(r'(href="[^"?]+\.css)"', r'\1?v=' + stamp + '"', html)
        html = re.sub(r'(src="[^"?]+\.js)"', r'\1?v=' + stamp + '"', html)
        return html.encode("utf-8")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name in WEB_FILES:
            path = os.path.join(PROJECT_DIR, name)
            if not os.path.exists(path):
                sys.exit("缺少文件：" + path)
            if os.path.isdir(path):
                for root, _dirs, files in os.walk(path):
                    for fn in files:
                        full = os.path.join(root, fn)
                        rel = os.path.relpath(full, PROJECT_DIR).replace("\\", "/")
                        if fn.lower().endswith(".html"):
                            z.writestr(rel, html_bytes(full))
                        else:
                            z.write(full, rel)
            elif name.lower().endswith(".html"):
                z.writestr(name, html_bytes(path))
            else:
                z.write(path, name)

    data = buf.getvalue()
    out_path = os.path.join(PROJECT_DIR, "director-web.zip")
    with open(out_path, "wb") as fh:
        fh.write(data)

    print(SEP)
    print("已生成静态站点压缩包（面板部署用）")
    print(SEP)
    print("路径：%s（%d KB）" % (out_path, len(data) // 1024))
    print("内容：%s（index.html 在压缩包根目录，解压到网站根目录即可）" % "、".join(WEB_FILES))
    print()
    print("用法：")
    print("  1) 面板里先建一个「静态 / 纯静态」站点（域名或 IP）")
    print("  2) 把该 zip 上传到站点根目录，再解压")
    print("  3) 浏览器打开站点地址即可")
    print("  宝塔：网站 → 站点 → 文件 → 上传 → 解压")
    print("  1Panel：网站 → 网站 → 站点 → 文件 → 上传 → 解压")
    print()
    print("弹幕网关与更多细节见 README「方式四：面板部署（1Panel / 宝塔）」。")


def deploy_pkg(client):
    """构建并上传部署包 + install.sh 到前端根目录，供 curl|bash 使用。"""
    print(SEP)
    print("构建并上传部署包（供 install.sh 下载）")
    print(SEP)
    buf = build_pkg_tar()
    print("部署包大小：%d KB" % (len(buf.getvalue()) // 1024))

    sftp = client.open_sftp()
    remote_pkg = WEB_REMOTE + "/director-console.tar.gz"
    sftp.putfo(buf, remote_pkg)
    print("已上传 -> " + remote_pkg)

    # 同时上传 install.sh
    install_path = os.path.join(PROJECT_DIR, "install.sh")
    if os.path.exists(install_path):
        sftp.put(install_path, WEB_REMOTE + "/install.sh")
        print("已上传 -> " + WEB_REMOTE + "/install.sh")
    sftp.close()
    print("部署包与 install.sh 已就绪")



def deploy_web(client):
    print(SEP)
    print("【1/2】部署导播台前端 -> %s:%s" % (HOST, WEB_REMOTE))
    print(SEP)
    buf = build_web_tar()
    print("本地打包完成：%d KB" % (len(buf.getvalue()) // 1024))

    sftp = client.open_sftp()
    remote_tar = "/tmp/director-web.tar.gz"
    sftp.putfo(buf, remote_tar)
    sftp.close()
    print("已上传到 " + remote_tar)

    run(client, "mkdir -p " + WEB_REMOTE)
    run(client, "tar -xzf %s -C %s" % (remote_tar, WEB_REMOTE))
    run(client, "rm -f " + remote_tar)

    print("\n校验文件：")
    run(client, "find %s -type f | sort" % WEB_REMOTE, quiet=True)

    print("\nHTTP 自检：")
    code, _ = run(client, "curl -s -o /dev/null -w 'HTTP %{http_code}' http://127.0.0.1/")
    print(SEP)
    if code == 0:
        print("前端部署完成，访问： http://%s/" % HOST)
    else:
        print("前端部署完成，但 HTTP 自检异常，请检查 nginx 容器。")

    # 同步刷新部署包，保证 install.sh 拉到最新代码
    deploy_pkg(client)


# ==================== 弹幕网关部署 ====================

def deploy_danmaku(client):
    print(SEP)
    print("【2/2】部署 B站弹幕网关 -> %s:%s" % (HOST, DM_REMOTE))
    print(SEP)

    sftp = client.open_sftp()
    run(client, "mkdir -p " + DM_REMOTE)
    for name in DM_FILES:
        local = os.path.join(DM_LOCAL, name)
        if not os.path.exists(local):
            sys.exit("缺少文件：" + local)
        sftp.put(local, DM_REMOTE + "/" + name)
        print("已上传 " + name)
    sftp.close()

    print("\n构建镜像（首次需拉取 python 基础镜像，稍候）…")
    code, _ = run(client, "docker build -t %s %s" % (DM_IMAGE, DM_REMOTE))
    if code != 0:
        print("镜像构建失败，请检查上面的输出。")
        return

    run(client, "docker rm -f %s 2>/dev/null || true" % DM_NAME)
    env_arg = ""
    if COOKIE:
        safe = COOKIE.replace("'", "'\\''")
        env_arg = " -e DANMAKU_COOKIE='%s'" % safe
    run(client, "docker run -d --name %s --restart unless-stopped -p %s:%s%s %s"
        % (DM_NAME, DM_PORT, DM_PORT, env_arg, DM_IMAGE))
    print("登录 Cookie：%s" % ("已注入" if COOKIE else "未注入（昵称显示为 ***）"))

    time.sleep(3)
    print("\n" + SEP)
    code, health = run(client, "curl -s --max-time 8 http://127.0.0.1:%s/health" % DM_PORT, quiet=True)
    print("健康检查：" + (health.strip() or "(无响应)"))
    run(client, "docker ps --filter name=%s --format '{{.Names}} | {{.Status}} | {{.Ports}}'" % DM_NAME)
    print(SEP)
    if '"ok"' in health:
        print("弹幕网关部署完成，网关地址： ws://%s:%s/danmaku" % (HOST, DM_PORT))
    else:
        print("弹幕网关已启动，但健康检查未通过，请看日志： docker logs %s" % DM_NAME)


# ==================== 增量上传 ====================

def upload_files(client, files):
    if not files:
        print("未指定文件，示例： python deploy.py upload index.html css/style.css")
        return
    sftp = client.open_sftp()
    for rel in files:
        local = os.path.join(PROJECT_DIR, rel)
        if not os.path.exists(local):
            print("[跳过] 文件不存在：" + local)
            continue
        remote = WEB_REMOTE + "/" + rel.replace("\\", "/")
        # 确保远端目录存在
        rdir = os.path.dirname(remote)
        run(client, "mkdir -p " + rdir, quiet=True)
        sftp.put(local, remote)
        print("已上传 -> " + remote)
    sftp.close()
    print("增量上传完成")


# ==================== 服务器状态 ====================

def server_status(client):
    print(SEP)
    print("服务器状态（%s）" % HOST)
    print(SEP)
    run(client, "docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}'")
    print()
    run(client, "curl -s -o /dev/null -w '导播台前端 HTTP %{http_code}\\n' http://127.0.0.1/")
    run(client, "curl -s --max-time 5 http://127.0.0.1:%s/health" % DM_PORT)
    print()


# ==================== 交互菜单 ====================

MENU = """
请选择部署操作：
  1) 全部部署（导播台前端 + 弹幕网关）
  2) 只部署导播台前端
  3) 只部署弹幕网关
  4) 增量上传指定文件
  5) 查看服务器运行状态
  6) 刷新部署包（供 curl|bash 使用）
  7) 打包静态站点 zip（1Panel / 宝塔 面板部署用）
  0) 退出
"""


def interactive(client):
    while True:
        print(MENU)
        try:
            choice = input("请输入选项 [0-5]：").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n已退出")
            return

        if choice == "0":
            print("已退出")
            return
        elif choice == "1":
            deploy_web(client)
            deploy_danmaku(client)
        elif choice == "2":
            deploy_web(client)
        elif choice == "3":
            deploy_danmaku(client)
        elif choice == "4":
            raw = input("请输入要上传的文件（空格分隔，相对项目根目录）：").strip()
            files = [f for f in raw.split() if f]
            upload_files(client, files)
        elif choice == "5":
            server_status(client)
        elif choice == "6":
            deploy_pkg(client)
        elif choice == "7":
            make_zip_package()
        else:
            print("无效选项，请输入 0-7")


# ==================== 入口 ====================

HELP = """网页导播台一键部署脚本

用法：
  python deploy.py              进入交互菜单
  python deploy.py all          部署前端 + 弹幕网关
  python deploy.py web          只部署导播台前端
  python deploy.py danmaku      只部署弹幕网关
  python deploy.py upload <f>.. 增量上传指定文件
  python deploy.py status       查看服务器状态
  python deploy.py pkg          刷新部署包（供 curl|bash 一键部署）
  python deploy.py zip          打包静态站点 zip（1Panel / 宝塔 面板部署用，不连服务器）
  python deploy.py -h           显示本帮助

环境变量：
  SSH_HOST / SSH_PORT / SSH_USER / SSH_PASS   SSH 连接信息
  DANMAKU_COOKIE                               B站登录 Cookie（可选）

一键自部署（在新服务器上执行）：
  curl -sSL http://43.139.182.16/install.sh | bash
"""


def main():
    args = sys.argv[1:]

    if args and args[0] in ("-h", "--help", "help"):
        print(HELP)
        return

    # 打包静态站点不需要连服务器，先处理掉
    if args and args[0].lower() in ("zip", "pack"):
        make_zip_package()
        return

    client = connect()
    print("已连接 %s@%s" % (USER, HOST))

    if not args:
        # 无参数：进入交互菜单
        try:
            interactive(client)
        finally:
            client.close()
        return

    cmd = args[0].lower()
    try:
        if cmd == "all":
            deploy_web(client)
            deploy_danmaku(client)
        elif cmd == "web":
            deploy_web(client)
        elif cmd == "danmaku":
            deploy_danmaku(client)
        elif cmd == "upload":
            upload_files(client, args[1:])
        elif cmd == "status":
            server_status(client)
        elif cmd == "pkg":
            deploy_pkg(client)
        else:
            print("未知命令：" + cmd)
            print(HELP)
    finally:
        client.close()


if __name__ == "__main__":
    main()

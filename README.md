# 网页低延迟多机位导播台

一个纯前端实现的多机位直播导播台，基于 WebRTC / WebCodecs 做帧级同步，支持画面切换、画中画、台标、音频混音、B站弹幕监看，并可通过 WHIP 回传到腾讯云快直播。

## 功能特性

- **多机位监看**：6 路机位同屏监看，基于 `MediaStreamTrackProcessor` 取原始 `VideoFrame`，帧级同步对齐
- **PGM 切换**：点击任一路即切到成品，支持叠化转场（时长可调）
- **画中画 PiP**：副机位叠加在成品左上角
- **台标**：上传图片，滑杆调节大小，下拉菜单选择四个角（左上/右上/左下/右下），自动持久化到浏览器
- **音频混音**：每路独立音量 + 静音，主音量，本机监听（防回声）
- **实时音量条**：每路机位底部带 VU 表，RMS 计算 + 峰值保持
- **帧同步**：自动补偿（标尺退到最慢那一路）+ 额外手动延迟，实时显示当前同步延迟
- **成品输出**：虚拟摄像头 / WHIP 回传（可选用腾讯云或阿里云，码率可调）
- **B站弹幕**：房间号连接，支持登录 Cookie 显示真实昵称，自动跑马灯状态
- **拉流通道**：内置腾讯云快直播 LEB（TCPlayer）、阿里云视频直播 RTS（Aliplayer）、自建 ZLMediaKit（WHEP），可在页面切换
- **每路机位拉流地址**：在「拉流通道」里为每个机位单独填完整拉流地址（腾讯云 / 阿里云都直接粘服务商生成的原地址，鉴权参数已含在地址里）；也可只填带 `{cam}` 占位符的地址模板兜底
- **机位来源可切换**：每路机位可选「流媒体 / 本地图片 / 本地视频 / 本机摄像头」，用本地素材或电脑摄像头当测试画面（彩排、垫片），无需真的推流

## 技术栈

- 前端：原生 HTML / CSS / JavaScript（无框架）
- 取流：腾讯云 TCPlayer 4.8.0（LEB）/ 标准 WHEP
- 帧同步：WebCodecs `VideoFrame` + `MediaStreamTrackProcessor`
- 音频：WebAudio API（`AnalyserNode` 旁路统计音量）
- 推流：WHIP（WebRTC HTTP Ingest Protocol）
- 弹幕网关：Python `websockets`（Docker 部署）
- 部署：Nginx 容器（前端）+ Docker（弹幕网关）

## 快速开始（本地开发）

```bash
# 克隆仓库
git clone https://github.com/MCSakura/web-director-console.git
cd web-director-console

# 用任意静态服务器打开 index.html 即可（推荐 VSCode Live Server 或 python -m http.server）
python -m http.server 8080
```

浏览器访问 `http://localhost:8080/`，需要 Chrome / Edge 94+（支持 `MediaStreamTrackProcessor`）。

> ⚠️ 公网访问必须 HTTPS，否则浏览器会禁用 WebRTC。

## 部署

项目提供三种部署方式，按需选择。

### 方式一：一键自部署（推荐，换服务器最方便）

在任意一台 Linux 服务器上以 root 执行：

```bash
curl -sSL http://43.139.182.16/install.sh | bash
```

脚本会自动完成：安装 docker → 下载部署包 → 启动 nginx 前端容器（端口 80）→ 构建并启动弹幕网关容器（端口 8099）→ 健康检查。

支持环境变量覆盖：

```bash
# 改端口
WEB_PORT=8080 DM_PORT=9099 curl -sSL http://43.139.182.16/install.sh | bash
# 换源服务器
SOURCE_URL=http://你的源服务器 curl -sSL http://43.139.182.16/install.sh | bash
# 注入 B站 Cookie（显示真实昵称）
DANMAKU_COOKIE='SESSDATA=...' curl -sSL http://43.139.182.16/install.sh | bash
```

### 方式二：本地脚本部署（paramiko SSH）

适用于从本地 Windows 推送到远程服务器：

```powershell
# 安装依赖
pip install paramiko

# 交互菜单（双击 deploy.bat 也行）
$env:SSH_PASS='你的SSH密码'
python deploy.py

# 或命令行模式
python deploy.py all        # 前端 + 弹幕网关
python deploy.py web        # 只部署前端
python deploy.py danmaku    # 只部署弹幕网关
python deploy.py upload index.html js/app.js   # 增量上传
python deploy.py status     # 查看服务器状态
```

Windows 用户可直接双击 `deploy.bat` 进入交互菜单。

### 方式三：手动部署

**前端**（Nginx 容器）：

```bash
mkdir -p /opt/director-web /opt/director-web-nginx
# 上传 index.html pgm.html css js 到 /opt/director-web/
cat > /opt/director-web-nginx/default.conf <<'EOF'
server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;
    location / {
        add_header Cache-Control "no-cache";
        try_files $uri $uri/ =404;
    }
}
EOF
docker run -d --name director-web --restart unless-stopped -p 80:80 \
  -v /opt/director-web:/usr/share/nginx/html:ro \
  -v /opt/director-web-nginx/default.conf:/etc/nginx/conf.d/default.conf:ro \
  nginx:alpine
```

**弹幕网关**（Docker）：

```bash
cd danmaku
docker build -t danmaku-gateway:latest .
docker run -d --name danmaku-gateway --restart unless-stopped -p 8099:8099 \
  [-e DANMAKU_COOKIE='SESSDATA=...'] \
  danmaku-gateway:latest
```

## 项目结构

```
web-director-console/
├── index.html              # 导播台主页面（含底部使用教程）
├── pgm.html                # OBS 浏览器源专用成品拉流页
├── css/style.css           # 样式
├── js/
│   ├── config.js           # 全局配置（机位、输出、拉流通道等）
│   ├── app.js              # 主逻辑：UI 绑定 + 渲染循环
│   ├── camera.js           # 机位源（WHEP 连接 + 帧缓冲）
│   ├── frameBuffer.js      # 帧缓冲队列
│   ├── syncEngine.js       # 帧同步引擎
│   ├── compositor.js       # 成品画布合成（切换/转场/PiP/台标）
│   ├── audioMixer.js       # 音频混音 + 音量统计
│   ├── outputManager.js    # 成品输出（虚拟摄像头 / WHIP 推流）
│   ├── providers.js        # 取流提供者（TCPlayer / Aliplayer / WHEP + 本地图片/视频/摄像头）
│   ├── whep.js             # WHIP/WHEP 客户端
│   ├── danmaku.js          # B站弹幕面板
│   └── pgm.js              # 成品页拉流逻辑
├── danmaku/
│   ├── gateway.py          # 弹幕网关 WebSocket 服务
│   ├── Dockerfile
│   └── deploy.py           # 弹幕网关独立部署脚本
├── deploy.py               # 统一部署脚本（交互菜单 + 命令行）
├── deploy.bat              # Windows 一键启动器
├── install.sh              # curl|bash 自部署脚本
├── upload.py               # 增量文件上传工具
└── poc/                    # 原型验证文件
```

## 配置说明

大部分设置可在页面右侧面板实时调整并保存到浏览器 `localStorage`，核心默认值在 `js/config.js`：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| 机位数量 | 6（cam01–cam06） | 可在 `config.js` 的 `cameras` 增减 |
| 成品分辨率 | 1920×1080 @ 60fps | `output.width/height/fps` |
| 回传码率上限 | 7 Mbps | `output.pushMaxBitrate` |
| 帧同步容差 | 120 ms | `alignToleranceMs` |
| 台标默认大小 | 12% 宽度 | `logoWidthScale` |

## 使用流程

1. 用 OBS 把 6 路画面推到腾讯云快直播，流名 `cam01`–`cam06`
2. 打开导播台页面，点「连接全部机位」
3. 点右侧机位按钮切换 PGM，调整画中画 / 台标 / 转场
4. 开启成品回传（WHIP 推腾讯云），OBS 用 `pgm.html` 浏览器源拉成品
5. 详见页面底部「使用教程」板块

## 后台运行

导播台窗口被遮挡/最小化时浏览器会暂停 `requestAnimationFrame`，导致成品冻结。长期无人值守请用以下参数启动 Chrome/Edge：

```
--disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-features=CalculateNativeWinOcclusion
```

## License

MIT

/**
 * 全局配置：所有与拉流通道、机位、成品输出相关的参数集中在此处修改。
 * 修改后刷新页面即可生效，无需重新构建。
 *
 * 大多数设置也可以在页面右侧「服务器设置」里改，改完存在浏览器 localStorage，
 * 刷新后依然生效；这里的值只作为默认值。
 */
window.DIRECTOR_CONFIG = {
  /** 推流应用名，对应 rtmp://<IP>/live/cam01 中的 live */
  app: "live",

  /**
   * 自建服务器地址：拉流通道的地址模板里若用了 {base} 占位符，就替换成这个值
   *（目前只有「自建 ZLMediaKit」的模板用到）。留空 = 与页面同源。
   * 注意：成品回传不用它，回传走各通道自己的 whipPushServer / whipPushMode。
   */
  serverBase: "",

  /** 当前使用的拉流通道 ID（对应下面 clouds 里的 id） */
  activeCloud: "tencent",

  /**
   * 拉流通道列表：在页面「服务器设置 → 拉流通道」里可随时切换，无需改代码。
   *
   * provider 取值：
   *   "whep"      —— 标准 WHEP / SDP 拉流（自建 ZLMediaKit 等）
   *   "tcplayer"  —— 腾讯云快直播 LEB（加载 TCPlayer，从 video.srcObject 取原生轨道）
   *   "aliplayer" —— 阿里云视频直播（加载 Aliplayer Web SDK，支持 RTS 超低延时 / FLV / HLS）
   *
   * 拉流地址有两种给法，优先用第一种：
   *   urls        —— 每路机位各自的完整地址（在页面「拉流通道 → 每路机位拉流地址」里填），
   *                  腾讯云 / 阿里云都直接粘服务商生成的原地址（鉴权参数已含在地址里）
   *   urlTemplate —— 兜底模板，上面留空的机位用它，支持 {cam} {base} {app} 三个占位符
   *
   * 注意：带防盗链的地址会过期（腾讯云 txTime / 阿里云 auth_key），换场次时更新地址即可。
   */
  clouds: [
    {
      id: "zlm",
      name: "自建 ZLMediaKit",
      provider: "whep",
      /** 留空 = 与页面同源（页面部署在 ZLMediaKit 的 www 目录时的写法） */
      base: "",
      urlTemplate: "{base}/index/api/webrtc?app={app}&stream={cam}&type=play"
    },
    {
      id: "tencent",
      name: "腾讯云 快直播 LEB",
      provider: "tcplayer",
      // LEB 播放地址必须是【播放域名】，不是推流域名
      urlTemplate: "webrtc://livepull.mcsakura.cn/live/{cam}",
      // TCPlayer 5.x 需要 License；4.8.0 免 License（官方已提示该版本即将下线）
      sdkUrl: "https://web.sdk.qcloud.com/player/tcplayer/release/v4.8.0/tcplayer.v4.8.0.min.js",
      licenseUrl: "",
      licenseKey: "",
      /**
       * 成品回传（WHIP 推流）走这个云时用的推流服务地址。
       * 腾讯云的 WHIP 服务地址是固定的，推流地址要作为 ?streamurl= 参数传过去（mode = streamurl）。
       */
      whipPushServer: "https://webrtcpush.tlivewebrtcpush.com/webrtc/v2/whip",
      whipPushMode: "streamurl"
    },
    {
      id: "aliyun",
      name: "阿里云 视频直播 RTS",
      provider: "aliplayer",
      /**
       * 每路机位拉流地址：把控制台生成的播流地址（形如
       * artc://播流域名/live/cam01?auth_key=…）逐条粘到对应机位。
       * 留空的机位回退用下面的 urlTemplate。
       */
      urls: {},
      /**
       * 兜底模板。artc:// 为超低延时直播（需在控制台开启「超低延时直播」并对播流域名配 HTTPS）；
       * 若走标准直播，可换成 http(s)://播流域名/live/{cam}.flv（或 .m3u8）。
       */
      urlTemplate: "artc://aliyunlivepull-sz.mcsakura.cn/live/{cam}",
      /**
       * 成品回传走阿里云时：WHIP 端点就是推流地址本身（把 artc:// 换成 https://），
       * 地址里已经带了 auth_key，不需要再传 streamurl 参数（mode = direct）。
       * 在页面「成品输出 → 回传」的下拉里选阿里云，再把该地址填进输入框即可。
       */
      whipPushServer: "",
      whipPushMode: "direct",
      // 阿里云 Web 播放器 SDK（RTS 超低延时已作为插件内置）
      sdkUrl: "https://g.alicdn.com/apsara-media-box/imp-web-player/2.28.3/aliplayer-min.js"
    }
  ],

  /** 机位列表，id 必须与推流时使用的串流密钥一致（当前 6 路） */
  cameras: [
    { id: "cam01", name: "机位 1" },
    { id: "cam02", name: "机位 2" },
    { id: "cam03", name: "机位 3" },
    { id: "cam04", name: "机位 4" },
    { id: "cam05", name: "机位 5" },
    { id: "cam06", name: "机位 6" }
  ],

  /** 全局时间基准机位（必须存在于 cameras 中） */
  referenceCameraId: "cam01",

  /**
   * 每路机位时间戳校准偏移（毫秒）。
   *
   * 各机位编码器时钟不同源，默认情况下需要在这里手工微调；
   * 若在 ZLMediaKit 里把 [protocol] modify_stamp 设为 1
   * （用 ZLM 接收时刻统一打时间戳），则多机位时间戳天然同源，这里保持 0 即可。
   */
  timestampOffsetMs: { cam01: 0, cam02: 0, cam03: 0, cam04: 0, cam05: 0, cam06: 0 },

  /**
   * 单路帧缓冲上限，超出后丢弃最旧帧，防止延迟持续累积。
   * 它同时决定「同步延迟」最多能补多大：可补范围 ≈ 帧数 ÷ 帧率（60fps 下 30 帧≈0.5 秒）。
   * 页面上不再提供输入框，需要调整请直接改这里。
   */
  maxBufferFrames: 30,

  /** 渲染帧率上限（成品画布的重绘频率），避免高刷屏/无头环境下空转浪费 CPU；设为 0 表示不限制 */
  renderFpsLimit: 60,

  /** 台标宽度（占成品画面宽度的比例，0.12 = 12%）；页面上可用「台标」组的滑杆实时调整 */
  logoWidthScale: 0.12,

  /**
   * 时间对齐容差（毫秒）：最接近帧与基准帧相差超过该值则视为无可用帧，跳过该路。
   * 页面上不再提供输入框，需要调整请直接改这里。
   */
  alignToleranceMs: 120,

  /**
   * 自动同步补偿上限（毫秒）：多机位各路上行延迟不一致时，标尺会自动退到
   * "最慢那一路"已经送达的时刻，让每一路都能取到同一瞬间的帧；最多退这么多。
   * 0 = 关闭（始终跟随基准机位最新帧，延迟最低，但慢的机位会缺帧）。
   */
  syncMaxDelayMs: 300,

  /** 额外手动同步延迟（毫秒）：在自动标尺基础上再往回退一点，用于手工微调 */
  syncExtraDelayMs: 0,

  /** 成品输出画布参数 */
  output: {
    width: 1920,
    height: 1080,
    fps: 60,
    /**
     * 成品回传（可选，页面「成品输出」里有开关）：WHIP 推到云上。
     *
     * 浏览器不能推/拉 RTMP，所以回传统一走 WHIP；落地后由 pgm.html 拉流观看（流名 pgm）。
     * 推哪个云由页面「成品输出 → 回传」的下拉框决定，选哪个云就用那个云的
     * whipPushServer / whipPushMode（见上面 clouds 里各通道的配置）。
     *
     * 若你选择「OBS 采集本页面后由 OBS 自己推」，则不需要开启此项。
     */
    whipPushServer: "https://webrtcpush.tlivewebrtcpush.com/webrtc/v2/whip",
    /**
     * 回传服务地址的用法：
     *   "streamurl"（腾讯云）—— 服务地址固定，把推流地址作为 ?streamurl= 参数传过去；
     *                          注意腾讯云 WHIP 跨域不放行 authorization 头，所以不用 Bearer 头。
     *   "direct"（阿里云）   —— 服务地址本身就是端点（artc:// 推流地址把协议换成 https://），
     *                          地址里已带 auth_key，不再追加参数。
     */
    whipPushMode: "streamurl",
    /**
     * 推流地址（仅 streamurl 模式需要；含 txTime / auth_key，会过期，换场次要重新生成）。
     */
    whipPushToken: "",
    /**
     * 回传推流的发送码率上限（bps）。上行带宽不足时，WebRTC 拥塞控制会把视频码率压低，
     * 表现为“画面卡顿、声音正常”；给个明确上限可避免码率先冲高再被压下来。
     * 上行带宽小就调小，例如 1500000（1.5Mbps）。
     */
    pushMaxBitrate: 7000000,
    /** 回传推流的采集帧率上限（默认与 fps 一致；调低可减轻 CPU 与带宽压力） */
    pushFps: 60,
    /** 成品流名 */
    streamName: "pgm"
  },

  /** 画中画宽度占成品画面宽度的比例 */
  pipScale: 0.28,

  /**
   * B站弹幕（仅监看）
   *
   * 浏览器不直连 B站：api.live.bilibili.com 不返回 CORS 头，弹幕本身也是自定义
   * 二进制协议。实际的取 token、连弹幕服务器、解包都在独立网关里完成
   * （见 danmaku/gateway.py），本页只跟网关用 WebSocket 通信。
   */
  danmaku: {
    /** 网关地址；留空则按页面主机自动推导 ws(s)://<当前主机>:<port>/danmaku */
    gatewayUrl: "",
    /** 自动推导时使用的端口 */
    port: 8099,
    /** 默认订阅的直播间号（短号或真实房间号都行），留空则不自动连接 */
    room: "",
    /** 列表最多保留多少条 */
    maxItems: 200
  }
};

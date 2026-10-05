/**
 * PGM 成品画面观看页（专供 OBS「浏览器源」使用）
 *
 * 作用：用与导播台相同的拉流通道（云 / 自建），拉取成品流并以全屏、无界面元素的方式播放；
 *       断流后自动重连，无需人工干预。
 *
 * 使用：
 *   OBS → 来源 → 添加「浏览器」→ URL 填 http://<服务器>/pgm.html
 *   建议勾选「关闭源时关闭浏览器」「刷新浏览器时刷新页面」，宽高设为 1920x1080。
 *
 * 播放策略：
 *   1) 先尝试带声音自动播放（OBS 浏览器源允许）；
 *   2) 被浏览器自动播放策略拦截时，改为静音自动播放（保证出画面、不黑屏），
 *      并显示「🔊 开启声音」按钮，点一下即可恢复声音。
 *
 * 可用查询参数覆盖默认配置：
 *   ?stream=pgm   成品流名（默认取 js/config.js 的 output.streamName）
 * 拉流通道沿用 js/config.js 里的 clouds / activeCloud。
 */
(function () {
  "use strict";

  const CFG = window.DIRECTOR_CONFIG;
  const params = new URLSearchParams(window.location.search);
  const streamName = params.get("stream") || CFG.output.streamName;

  const video = document.getElementById("pgmVideo");
  const statusEl = document.getElementById("pgmStatus");
  const playBtn = document.getElementById("pgmPlay");

  let provider = null;
  let currentStream = null;
  let retryTimer = null;
  let retryDelay = 1000;
  let stopped = false;

  function setStatus(text) {
    if (text) {
      statusEl.textContent = text;
      statusEl.style.display = "block";
    } else {
      statusEl.style.display = "none";
    }
  }

  function showPlayButton(label) {
    playBtn.textContent = label;
    playBtn.style.display = "block";
  }

  function hidePlayButton() {
    playBtn.style.display = "none";
  }

  /**
   * 播放视频：先试着带声音自动播放；被拦就退成静音自动播放。
   * 静音自动播放几乎在所有环境（含浏览器、OBS）都被允许，可避免黑屏。
   */
  function tryPlay() {
    video.muted = false;
    const p = video.play();
    if (!p || !p.catch) {
      hidePlayButton();
      return;
    }
    p.then(function () {
      retryDelay = 1000;
      setStatus("");
      hidePlayButton();
    }).catch(function () {
      // 带声音被拦：改静音自动播放
      video.muted = true;
      const p2 = video.play();
      if (!p2 || !p2.catch) {
        showPlayButton("🔊 开启声音");
        return;
      }
      p2.then(function () {
        setStatus("");
        showPlayButton("🔊 开启声音");
      }).catch(function () {
        setStatus("浏览器阻止了自动播放，请点击下面的按钮开始播放");
        showPlayButton("▶ 播放");
      });
    });
  }

  function attachTrack(track) {
    if (!currentStream) currentStream = new MediaStream();
    currentStream.addTrack(track);

    if (video.srcObject !== currentStream) video.srcObject = currentStream;

    track.addEventListener("ended", function () { scheduleReconnect("轨道结束"); });
    tryPlay();
  }

  function teardown() {
    if (provider) {
      provider.close();
      provider = null;
    }
    if (currentStream) {
      currentStream.getTracks().forEach(function (t) {
        try { t.stop(); } catch (e) { /* ignore */ }
      });
      currentStream = null;
    }
    video.srcObject = null;
  }

  function scheduleReconnect(reason) {
    if (stopped || retryTimer) return;
    teardown();

    const wait = Math.round(retryDelay / 1000);
    setStatus("等待导播输出…" + (reason ? "（" + reason + "）" : "") + "\n" + wait + " 秒后重试");

    retryTimer = setTimeout(function () {
      retryTimer = null;
      connect();
    }, retryDelay);

    // 退避重试，最长 10 秒
    retryDelay = Math.min(retryDelay * 2, 10000);
  }

  function connect() {
    if (stopped) return;

    const cloud = getCloudById(CFG, CFG.activeCloud) || (CFG.clouds || [])[0];
    if (!cloud) {
      setStatus("未找到可用的拉流通道配置");
      return;
    }

    setStatus("正在连接 " + streamName + " …");

    provider = createStreamProvider(cloud, streamName, CFG, {
      onTrack: attachTrack,
      onStateChange: function (state) {
        if (state === "failed" || state === "disconnected") {
          scheduleReconnect("连接中断");
        }
      }
    });

    Promise.resolve(provider.start()).catch(function (err) {
      scheduleReconnect(err && err.message ? err.message : String(err));
    });
  }

  playBtn.addEventListener("click", function () {
    video.muted = false;
    tryPlay();
  });

  window.addEventListener("beforeunload", function () {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    teardown();
  });

  connect();
})();

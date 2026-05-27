# EvSense

> WiFi 隐身感知 · 银发陪伴机器人技术栈
>
> Fork of [ruvnet/RuView](https://github.com/ruvnet/RuView)

---

## 这是什么

EvSense 是把 WiFi CSI 隐身感知技术做成**面向中国银发市场的陪伴机器人产品**的项目。

技术栈基于 `ruvnet/RuView`（开源 WiFi-DensePose 实现），但产品定位、UI、场景、AI agent 决策层都是我们独立设计。

**核心三句话**：

1. **算法不是壁垒**：WiFi CSI sensing 是学术界 2011 年起的成熟技术（Halperin et al. → CMU DensePose-from-WiFi 2021）。RuView 是工程整合 + 多节点 mesh。
2. **EvSense 不重新发明轮子**：基于 RuView 算法 + ESP32 固件 + 多节点协议。把这些当作"60 分基础"。
3. **EvSense 真正护城河在 LLM agent 决策层 + 中国银发场景落地**：传感数据 → LLM 主动决策（呼叫子女 / 调节家电 / 紧急联系），不是另一个跟 Aqara/Hex Home 拼传感精度的产品。

---

## 跟 upstream RuView 的差异

### 已做（2026-05-27 v0 fork commit）

| 模块 | 我们改了什么 | 为什么 |
|---|---|---|
| `ui-v2-mockup/observatory-cn/` | Fork upstream `ui/observatory*`，做中文化 + Three.js 粒子化 pose viz | 银发场景要中文、要直观人形（不是抽象 wireframe）|
| `hud-controller.js` | `target=0` 时 presence-aware 保持上次值 | 单节点 vitals 偶发 0 导致数字 1 秒跳 5-10 次（眼睛累）|
| `hud-controller.js` | `confidence` clamp 到 `[0,100]` | RuView sensing-server 偶发返回 confidence>1.0（1.43 等），dashboard 显示 143% |
| `hud-controller.js` + `demo-data.js` | DEFAULTS 改 `dataSource='ws'` + `scenario='single_breathing'` + `autoMode=false` | RuView 默认是内置假数据 + 自动巡演——demo 时极易误导观众 |
| `main.js` + `hud-controller.js` | localStorage key 前缀 `ruview-` → `evsense-` | 彻底改名第一步 |
| UI 品牌 | RuView → **EvSense**（title / brand-logo / tagline）| Fork 身份 |

### Roadmap — 彻底改名待办

| 改名范围 | 工作量 | 影响 |
|---|---|---|
| Docker image name `ruvnet/wifi-densepose:latest` → `evsong/evsense:latest` | 大 | 需要自建 image、push Docker Hub、改 Pi 部署 |
| Rust crate names `wifi-densepose-*` → `evsense-*`（15 个 crate）| 大 | break crates.io 引用，分叉 |
| Binary names `sensing-server` `homecore-server` → `evsense-server` | 中 | 改 docker-entrypoint.sh + build |
| API path `/api/v1/sensing` → `/api/v1/evsense` | 小 | 改 sensing-server route + dashboard fetch |
| README.md 主体改写 | 中 | 但失去 upstream sync 价值 |
| 删 RuView 不要的模块（`cog-ha-matter`, `homecore-server`, `WASM runtime`, `OTA`）| 中 | EvSense 不做智能家居 bridge，删后 RAM/flash 省 ~30% |

短期不彻底改是因为：**ruvnet 还在活跃维护（5/26 ship v1409 修 NVS bug 给我们省了几小时）**，分叉过早会失去 upstream patches。等我们 product/market fit 后再 hard fork。

### EvSense 独有规划（不在 upstream 也不需要 sync）

| 模块 | 状态 | 描述 |
|---|---|---|
| AI agent 决策层 | 计划 | 订阅 `/ws/sensing` WS → LLM (DeepSeek-V4 / Claude Haiku 4.5) → 飞书/微信推送给子女 / 喇叭 Edge-TTS |
| 飞书/微信集成 | 计划 | 老人 4h 未动 → 自动联系 |
| 中国银发场景定制 | 计划 | 大字体语音 + 萌宠形象 + 拒绝多人追踪/姿态估计这些跟场景无关的功能 |
| 跌倒检测 → 主动呼叫 | 计划 | RuView 跌倒检测 + EvSense 决策"呼叫哪个儿女说什么"|
| 隐私优先（无摄像头）卖点 | 设计中 | PIPL 合规：老人生理数据 = 敏感信息，明示同意 + 本地化 |
| 4 节点 mesh 优化 | 进行中 | 节点 1+2 充电头/WiFi 死区问题排查 |

---

## 部署 / 运行

### 当前部署形态

```
[ESP32-S3 × 4 节点 (烧 ruvnet esp32-csi-node v0.6.6 + provision NVS)]
     ↓ UDP CSI 帧 → 192.168.x.y:5005
[Pi 4B (ruview-pi)]
     ↓ Docker 容器 ruvnet/wifi-densepose:latest, CSI_SOURCE=esp32
[Pi sensing-server (Rust + Axum)]
     ↓ WS ws://ruview-pi:3001/ws/sensing
[Pi /app/ui/observatory.html (EvSense 中文版, docker cp 进容器)]
     ↓ 浏览器
http://ruview-pi.local:3000/ui/observatory.html
```

### 烧节点

参考 [项目档](https://github.com/evsong/EvSense/issues)（待开 issue）。模板：

```bash
cd firmware/esp32-csi-node
~/.local/pipx/venvs/esptool/bin/python provision.py \
  --port /dev/cu.usbmodem<SN> \
  --ssid <WiFi-SSID> --password <pwd> \
  --target-ip <Pi-IP> --target-port 5005 \
  --node-id <1|2|3|4> --tdm-slot <0|1|2|3> --tdm-total 4 \
  --edge-tier 2 --dry-run

esptool --chip esp32s3 --port /dev/cu.usbmodem<SN> --baud 921600 \
  write-flash --flash-mode dio --flash-size 8MB \
  0x0     release_bins/bootloader.bin \
  0x8000  release_bins/partition-table.bin \
  0x9000  nvs_provision.bin \
  0x20000 release_bins/esp32-csi-node.bin
```

⚠️ App 在 `0x20000` 不是 README 写的 `0x10000`（partitions_display.csv 8MB 布局）。

⚠️ **必须用 v0.6.6+ 固件**（5/21 ship）。v0.6.4 有 NVS read bug，node_id 无论怎么 provision 都 fallback 到 Kconfig default=1。

### 部署中文 UI 到 Pi 容器

```bash
scp ui-v2-mockup/observatory-cn/observatory/js/*.js \
    ui-v2-mockup/observatory-cn/index.html \
    ev@<pi>:/tmp/
ssh ev@<pi> 'docker cp /tmp/index.html ruview:/app/ui/observatory.html
             docker cp /tmp/*.js       ruview:/app/ui/observatory/js/'
```

⚠️ `docker rm + docker run` 重建容器会丢这些改动（容器 mount 是空，UI 烤在镜像里）。短期可忍受，长期要 fork Docker image。

---

## 致谢

- [ruvnet/RuView](https://github.com/ruvnet/RuView) — 开源 WiFi-DensePose 实现，提供 ESP32 固件 + Rust sensing-server + dashboard 基础架构
- [Geng et al. (CMU 2021)](https://arxiv.org/abs/2301.00250) — DensePose from WiFi 原始论文
- [espressif/esp-csi](https://github.com/espressif/esp-csi) — ESP32 CSI 提取工具栈
- [Halperin et al. (UW 2011)](https://dhalperi.github.io/linux-80211n-csitool/) — CSI sensing 的鼻祖

---

**当前版本**：v0 (2026-05-27 initial fork)
**Maintainer**：[@evsong](https://github.com/evsong)
**协议**：跟随上游（MIT OR Apache-2.0）

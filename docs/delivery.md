# 交付与部署指引（delivery）· Anima 生图网站 —— 上线终版

> 产出：devops-engineer ｜ 更新：2026-09-13（Sprint 16 终版；替代 Sprint 8 版本）
> 当前基线：**Worker `f62e506e`（广告已下线 + 每日流量统计）+ 引擎 Kaggle v19/version 25（qwen 主槽 + mimo/hy3 兜底）+ GitHub HEAD 14fc5a4**
> 依据：docs/tech-design.md v2.0 + web-compliance 技能逐项核对

---

## 1. 系统现状（上线时点）

```
浏览器 ── https://animadraw.cloud（Cloudflare Worker anima-web，自定义域已生效）
   │  静态资产（index/result 两页，零第三方脚本）+ /api/* + Cron */15
   ├── D1 anima-tasks：任务状态机 + 队列（原子 claim、单 IP 并发限制、24h 回看窗口）
   ├── KV：图片 ref/* result/*（即用即删）+ stats/* uv/*（每日流量，90 天 TTL）
   └── 引擎唤醒：Kaggle 直推 kernels/push 优先（KAGGLE_API_TOKEN）→ GitHub Actions 兜底
Kaggle T4×2 引擎 reagino/animabot-engine v19（ComfyUI + AnimaV1 + AutoPrompt Agent）
   └── LLM：b.ai 网关 qwen3.8-flash 主槽 → mimo-v2.5 → hy3（按序 failover，secrets dataset 配置）
统计：POST /api/stats/hit（PV/UV，无 IP/UA 收集）→ GET /api/stats/summary?days=30（公开只读看板）
```

### 与旧版交付的差异（本版变更）
| 项 | 旧 | 新（Sprint 16 / v19） |
|---|---|---|
| 变现 | HillTopAds Popunder/Push/Banner 三件套 | **全部移除**（用户拍板），无任何第三方脚本 |
| 统计 | 无 | 自建每日 PV/UV/任务数（KV，90 天保留，隐私零收集） |
| LLM 兜底 | glm-5.3-flash | mimo-v2.5 → hy3（glm 因上游余额耗尽删除） |
| 参考图 | 三连 bug（识别器被离线开关掐死/选择节点 KeyError/日志不可读） | 已修复 + TaskLog 打点（ref_recognized/ref_selected） |

---

## 2. 已完成的上线前自查（web-compliance 逐项）

### ✅ 已落实（代码侧验证过）
- [x] **HTTPS**：Cloudflare 边缘证书，全站无混合内容（页面零外链资源）
- [x] **第三方脚本审计**：广告移除后，两页 `<script>` 仅剩本站 ES module（home.js/result.js）；无统计 SDK——统计是站内 API，无跨域
- [x] **隐私最小化**：不收集 IP（日志/统计均不含；任务表只存加盐哈希 ip_hash 用于单 IP 限流，不可回溯）、不收集 UA、无 Cookie（只用 localStorage/sessionStorage 存必要状态）
- [x] **统计去标识**：uv 用本机自生成随机 UUID 的 SHA-256 摘要（非指纹、不可反推、按日分键 90 天自动清）
- [x] **Cookie 同意条**：首次访问展示，"知道了"后记录；文案已更新为"必要本地存储，无第三方跟踪"
- [x] **UGC 内容安全**：政治敏感词恒定过滤（Worker 端）+ NSFW 标签检测（NSFW_FILTER_ENABLED，当前 false）+ 上游 LLM 内容审核（b.ai 网关）三道闸
- [x] **AI 生成标识**：结果图嵌 GB 45438-2025 元数据 + 页面"AI 生成"徽章 + 页脚声明
- [x] **无障碍基线**：语义化标签/键盘可达/aria 标注（Sprint 1-11 已验，Sprint 16 冒烟复验无回归）
- [x] **noindex**：meta + X-Robots-Tag + robots.txt Disallow 三层
- [x] **安全头**：X-Robots-Tag、Referrer-Policy（no-referrer-when-downgrade）；CSP 可选未配（无第三方资源，收益有限）
- [x] **错误处理**：失败任务带 engine_log、24h 回看窗口、Cron 30min 悬挂超时
- [x] **测试**：Python 引擎 24/24、Worker 16/16（含统计 4 例）、浏览器冒烟（无报错/无第三方/提交流程）

### ⚠️ 用户侧待办（无法代做）
1. **ICP 备案**：站点部署在 Cloudflare 海外边缘，**法律上不强制**；但大陆用户直连 `animadraw.cloud`（阿里云注册域名解析至 CF）速度/可达性视线路而定。若要大陆稳定访问 → 完成 ICP 备案（阿里云可代办）后在页脚展示备案号。**小范围使用（~20 人/天）可不备案直接上线**。
2. **域名续费提醒**：animadraw.cloud 在阿里云，注意续费周期；DNS 已指向 Cloudflare（karina/merlin.ns.cloudflare.com）。
3. **（可选）密码保护**：站内无账号体系，靠小圈子传播 + noindex 控制可见性。如需更严，可在 Cloudflare 开 Zero Trust Access 给域名加访问门槛（10 分钟配置，免费 50 用户内）。

---

## 3. 上线检查单（发布前最后一遍，10 分钟）

- [ ] 打开 https://animadraw.cloud → 首页五个标签正常、无广告位、无 console 报错（F12）
- [ ] 提交一条自然语言任务 → 排队 → 出图（暖态 ≤6min；引擎离线时首单会等唤醒，≤10min）
- [ ] 带参考图提交一单 → 结果应体现参考图特征；若失败看失败卡 `ref_recognized/ref_selected` 打点
- [ ] 结果页：下载 PNG/JPEG、"再生成一张"、灯箱正常
- [ ] 手机（或无痕窗口）走一遍完整流程（响应式 + 会话隔离验证）
- [ ] 查看 `https://animadraw.cloud/api/stats/summary?days=7` 有今日 PV/UV 数据
- [ ] Kaggle 引擎额度：kaggle.com → Notebooks 确认 GPU 配额余量（30h/周）

## 4. 上线后运维

| 事项 | 方法 | 频率 |
|---|---|---|
| 流量看板 | `GET /api/stats/summary?days=30`（浏览器直接开） | 随时 |
| 引擎离线 | 自动：任务创建触发 Kaggle 直推唤醒；无需人工 | 自动 |
| LLM 余额 | b.ai 后台看 qwen/mimo 余额；hy3 上游 429 属其网关配额，不影响前两槽 | 每周 |
| 模型/密钥变更 | 改 secrets dataset（`%TEMP%\push_secrets_rest.py` 通道）+ Kaggle Save & Run | 按需 |
| 代码更新 | 本地改 → Contents API 推 GitHub（`push_via_contents_api.py`）→ kernels push | 按需 |
| KV 统计清理 | 自动（90 天 TTL + 周一 Cron 保险清扫） | 自动 |
| 额度水位 | Workers 免费档 10 万 req/天、D1 读 500 万/天——当前流量余量 >100× | 月度 |

## 5. 回滚预案

- Worker：`npx wrangler rollback`（回上一版本）；版本历史在 Cloudflare 控制台
- 引擎：Kaggle notebook 版本历史一键回退（version 24 = v18 基线）
- 广告恢复：`config.js ads.enabled=true` + 重新注入 HillTopAds 三段代码（留存于 git 历史 e76d9cb）

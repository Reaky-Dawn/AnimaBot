# SPRINTS.md · Sprint 契约清单（Anima 生图网站）

> 产出角色：architect（技术架构师）｜ 契约格式遵循 AGENTS.md 第 5 节
> 上游依据：`docs/tech-design.md` v2.0（技术方案：Cloudflare Workers + D1 + R2，用户已确认）、`docs/PRD-Anima-2026-08-22.md`（验收标准 AC-P0 / AC-P1）、`docs/interface-design.md`、`styles/design-tokens.css`
> 状态约定：全部初始为**待办**；实现中→**进行中**；QA 验收通过→**通过**；被打回→**打回**（状态由总监/执行者实时更新到本文件）
> 执行约定：每次对话只推进一个 Sprint；实现者发现契约不可行 → 停止并回报架构师修订契约，禁止私自改方案（AGENTS.md 第 5 节）

## Sprint 依赖总览（M1 = Sprint 1–8，M2 = Sprint 9）

```
S1 骨架 → S2 主页输入 → S3 提交与单IP → S4 轮询进度 → S5 结果页
   → S6 广告与合规 → S7 NSFW拦截 → S8 M1联调回归 → S9 4x放大(M2)
（线性依赖；S6 的广告占位/Cookie 部分技术上可提前，但正式依赖 S5 结果页功能）
```

> **后端平台（用户已确认）**：Cloudflare Workers + D1 + R2 单一部署单元。S1 建 Worker 项目骨架（wrangler + Static Assets 目录），S3/S4/S5 前端以 **mock 模式**驱动（`api.js` 内置内存 mock，模拟 Worker API 语义：409/IP_BUSY、状态推进、presign 直链），S8 切换到真实 D1/R2 联调。引擎侧（Kaggle）改走 Worker `/api/engine/*`，为后端契约（devops-engineer 与站务执行），前端不依赖其内部实现。

---

## Sprint 1
status:      通过 ✓（QA 验收报告：docs/_qa_shots/sprint-1-report.md）
goal:        Worker 项目骨架 + 双页面静态骨架：建 wrangler 项目结构（src/index.js + public/ Static Assets 目录 + wrangler.toml），index.html（主页）+ result.html（结果页）静态结构、引用 design-tokens.css、两页共享基础布局与组件样式（main.css），页面骨架先行可用
impl:        ① 项目根建 `anima-web/` Worker 项目：`wrangler.toml`（name/main/assets 目录/d1_bindings/r2_bindings/cron_triggers 占位，本地 dev 模式即可跑）、`package.json`（wrangler devDependency，**不全局安装**）、`src/index.js`（最小 Worker：静态资产回退 + `/api/health` 探活，接口业务 Sprint 3/8 落地）、`public/` 静态目录；② 按 interface-design 2.1.1/2.2.1 文字线框建立 index.html 与 result.html 语义化区块骨架（header/main/footer、Hero、主卡片、上传区、任务状态区、广告区、页脚四说明容器、结果画廊容器）；③ 新建 styles/main.css，全部样式只引用 design-tokens.css 变量（无魔法值），覆盖：页面容器 max-width/边距、顶部栏、卡片、按钮基础、断点响应式（--breakpoint-*）、安全区（--safe-area-bottom）、星点/极光背景、prefers-reduced-motion 降级；④ 两页 `<head>` 内联引用 design-tokens.css + main.css；⑤ 页面 JS 仅挂空的 `<script type="module">` 入口占位（不实现逻辑）；⑥ public/ 下建 robots.txt 与 _headers（noindex，双保险之一，AC-P0-26 前置）
criteria:   （QA 逐条可验证）
            1. index.html / result.html 均存在（public/ 下），`npx wrangler dev` 可启动，站点根直达 index.html，result.html 可通过地址访问（PRD 4.1）
            2. 两页 `<link>` 均引用 styles/design-tokens.css 与 styles/main.css，CSS 生效（无 404）
            3. main.css 与页面内联样式中不存在设计令牌变量之外的魔法颜色/字号/间距（代码审查 grep 抽查）
            4. 桌面 ≥1024px：容器 1080px 居中、左右边距 --space-xl；移动 ≤767px：全宽 + --space-md 边距（interface-design 3.5）
            5. 移动端页脚/固定元素 padding-bottom 应用 --safe-area-bottom（NGR-23）
            6. 两页语义化标签（header/main/footer）齐全，无 JS 依赖下布局骨架完整可见
            7. `/api/health` 返回 200（Worker 骨架可运行）；robots.txt 含 `Disallow: /`；_headers 生效（响应头含 X-Robots-Tag）
layer:       ui（HTML/CSS 骨架）+ Worker 项目骨架；config 层无依赖
blocked_by:  none

---

## Sprint 2
status:      通过 ✓（QA 验收：14/14 交互测试通过，报告见 Sprint 1 自动测试脚本 scripts/qa-sprint2.mjs）
goal:        主页输入与参考图上传完整交互：描述输入（示例 chips / 500 字计数 / 空与超长校验）+ 参考图上传（格式/大小校验、缩略预览、移除、常驻须知、本地压缩 NFR-04），提交按钮触发校验（F01/F04/F05/F06）
impl:        ① types/task.js 先建（输入限制常量：描述上限 500、图片 ≤5MB、图片格式白名单、状态枚举含 ref_pending）；② config/config.js 建（输入限制、上传压缩参数：≤1024px、JPEG q0.8、API 端点同域 /api/*）；③ ui/components.js 实现 PromptInput（计数/错误描边 --color-error）、ExampleChips（点击填充+聚焦+光标置尾）、RefImageUploader（隐藏 input[type=file] + 点击/拖拽、校验、Canvas 压缩、缩略预览 --thumb-size、移除按钮、常驻须知"不得上传未经授权的真人照片或他人作品" NFR-16）、GenerateButton（点击触发校验）；④ 校验错误文案："请输入描述"（AC-P0-05）、"描述过长"（AC-P0-06）、"仅支持常见图片格式"/"图片过大，请压缩后上传"（AC-P0-09）；⑤ 校验通过后仅触发一个占位提交事件（本轮不做真实建任务，Sprint 3 接入）
criteria:   （QA 逐条可验证）
            1. 空描述点"生成"→ 提示"请输入描述"，不进入任何提交流程（AC-P0-05）
            2. 描述超 500 字 → 实时计数变 --color-error 并提示"描述过长"，提交被阻止（AC-P0-06）
            3. 选择 1 张图片 → 显示缩略预览 + "已添加参考图"提示（AC-P0-07）
            4. 已添加参考图 → "移除"后预览消失（AC-P0-08）
            5. 选择非图片格式 / 超 5MB 文件 → 提示对应错误、不进入提交流程；重新选择合法文件后错误态清除（AC-P0-09）
            6. 不传参考图直接提交 → 无报错、进入占位提交事件（完整任务创建在 Sprint 3 验证，AC-P0-10 前置行为）
            7. DevTools 实测：上传 >1MB 图片后压缩生效（Network/内存观察，NFR-04）
            8. 上传须知文案常驻可见（NFR-16）；用户描述仅纯文本渲染（textContent，NFR-06）
layer:       types → config → ui（组件）；service 占位
blocked_by:  Sprint 1

---

## Sprint 3
status:      通过 ✓（QA 验收：10/10 交互测试通过，报告见 docs/_qa_shots/sprint-3-report.md，脚本 scripts/qa-sprint3.mjs）
goal:        任务提交与单 IP 限制：建任务（repo/api.js 客户端 + mock 模式）、提交成功输入区整体锁定变灰、前端防重复提交 + 服务端 409 处理、无额度提示（F09/F11）
impl:        ① config/config.js 补：API 端点（同域 /api/*，`api.mode='mock'` 开发期）、轮询间隔、单任务提示文案；② repo/api.js 定义统一接口 `createTask/getTask/deleteTask/confirmRefDelivered/presignResultUrl` 并实现 mock 版（内存任务表，模拟 201/409/404/状态推进/presign 直链语义，供 S4/S5 复用；Worker 真实实现 Sprint 8 切换）；③ repo/storage.js：sessionStorage 任务元数据（`anima_task_meta`，含 task_token）、localStorage 进行中标记（`anima_active_task`）；④ service/task-service.js：submit()（校验已在 UI 层完成→有参考图先 Canvas 压缩→调 repo.createTask→(有参考图) mock 直传→confirmRefDelivered→成功写 sessionStorage/localStorage→返回任务；409 → 抛 IP_BUSY）；⑤ runtime/home.js：提交状态机（初始→已提交：输入区/上传区/chips/生成/移除全部 disabled + 禁用态令牌 --color-btn-disabled-*、--text-disabled、--color-placeholder 弱化，无"新任务"按钮）；⑥ 提交瞬间按钮禁用防连点
criteria:   （QA 逐条可验证）
            1. 提交成功 → 输入区与上传区全部变灰锁定（textarea/上传框/移除/chips/生成不可编辑不可点），页面不报错不跳走（AC-P0-01）
            2. 锁定态下无"新任务"按钮、无第二任务入口（interface-design D1/D2）
            3. mock 下已存在进行中任务时再次提交 → 提示"当前已有任务进行中，请等待其结束后再提交"，不进入执行（AC-P0-11 前端 + mock 服务端路径）
            4. 全程不出现任何额度/次数受限类文案（AC-P0-13 前半）
            5. 提交后 sessionStorage 写入任务元数据（任务标识/task_token/描述摘要，不含图片内容）；localStorage 写入进行中标记（NFR-21 数据基础）
            6. 不传参考图提交正常创建任务（AC-P0-10 完成验证）；传参考图走压缩→直传→confirm 链路（mock）
            7. 提交瞬间按钮禁用、无连点重复建任务
layer:       types → config → repo → service → runtime → ui（垂直切片：提交链路）
blocked_by:  Sprint 2

---

## Sprint 4
status:      通过 ✓（QA 验收：20/20 交互测试通过，报告见 docs/_qa_shots/sprint-4-report.md，脚本 scripts/qa-sprint4.mjs）
goal:        任务轮询与 5 节点进度条：状态轮询（间隔/失焦暂停/退避）、节点只进不退、排队"前方等待 N 人"、同会话刷新恢复（F07/F08 + 中间存储对接）
impl:        ① repo/api.js mock 扩展：getTask(id)、队列模拟（多 IP 排队→queue_pos 计算、状态机推进 queued→prompting→prompt_done→drawing→done/failed）；② config 补轮询参数：间隔 1.5s、无变化退避至 3s、visibilitychange 暂停；③ service/task-service.js 补 watchTask()（轮询循环、终态判定、最大节点持久化）；④ ui/components.js 实现 TaskStatusPanel 节点进度条：5 节点（排队中→提示词构思中→提示词完成→绘制中→完成/失败），节点圆形 --progress-node-size、完成 --color-success 绿勾 / 当前 --color-primary glow / 待办 --color-progress-track、连线 --color-progress-fill，横向（桌面）/纵向（移动）；节点 1 小字"前方等待 N 人"（--color-info、tabular-nums）；⑤ runtime/home.js：轮询启动/暂停/恢复、sessionStorage 恢复进度（NFR-21）、aria-live 播报
criteria:   （QA 逐条可验证）
            1. mock 下任务全程节点只前进不回退，最终落在"完成"或"失败"（AC-P0-02）
            2. mock 模拟 2+ 个 IP 并发排队时，后入队任务节点 1 显示"前方等待 N 人"，N 与实际排队顺序一致（F07、AC-P0-12 前端展示层）
            3. 队列为空提交 → 不显示等待人数，直接进入后续节点（AC-P0-13 后半）
            4. 页面隐藏（切 Tab）→ 轮询暂停；恢复可见 → 立即补一次轮询并恢复（NFR-03）
            5. 任务进行中刷新页面 → 进度/排队位置恢复（NFR-21）
            6. 轮询网络异常 → 不崩溃、退避重试、有可见提示
            7. 进度条桌面横向、移动纵向（interface-design 3.5）；aria-live 播报进度变化
layer:       repo → service → runtime → ui（轮询链路垂直切片）
blocked_by:  Sprint 3

---

## Sprint 5
status:      通过 ✓（QA 验收：22/22 交互测试通过，报告见 docs/_qa_shots/sprint-5-report.md，脚本 scripts/qa-sprint5.mjs）
goal:        终态自动跳转 + 结果页完整功能：主页完成/失败停留 1.5s 自动跳转；结果页加载任务、画廊展示 + "AI 生成"徽章、下载 PNG/JPEG、放大灯箱、失败态重试、任务无效态、再生成一张（F02/F03/F10/F12）
impl:        ① runtime/home.js：轮询到 done/failed → 节点 5 终态展示（--color-success 绿勾 / --color-error 红标 + "生成完成/失败，正在前往结果页…"）停留 1.5s → `location.href='result.html?task=<id>'`（AC-P0-03/18 跳转语义，主页无"查看结果"按钮）；② result.html + runtime/result.js：读 URL task 参数 → repo.getTask → 成功态/失败态/无效态渲染；③ ui/components.js 补：ResultGallery（画廊内衬 --bg-gallery、占位渐进呈现 NFR-02、"AI 生成"徽章 --gradient-ai-badge、alt 含"AI 生成"）、ActionBar（下载 PNG/JPEG、放大 4x 占位按钮[M2]、重试）、Lightbox（role=dialog + aria-modal、Esc/关闭按钮/点遮罩关闭、锁背景滚动、焦点移入/归还、灯箱内 AI 徽章）、InvalidTaskCard（404/过期 → 星尘青图标 + "任务不存在或已过期" + 返回主页主按钮）、ShareNotice（"请勿外传链接" NFR-18）；④ service 补：结果展示（mock 返回 result_url 直链语义 → `<img src>` 展示）、下载（fetch(result_url)→Blob→`<a download>`，PNG 直存 / JPEG 用 Canvas 转码；mock 下用生成的 blob）、重试（携带 sessionStorage 原描述+参考图回主页重排）、再生成一张（清 sessionStorage 回 index.html 全新输入态）
criteria:   （QA 逐条可验证）
            1. 节点"完成"→ 主页终态展示约 1.5s 后**自动跳转** result.html?task=<id>，无需点击，主页无"查看结果"按钮（AC-P0-03/14）
            2. 结果页展示 1 张生成图片（AC-P0-03）
            3. "下载 PNG"/"下载 JPEG"均可触发浏览器下载，文件可正常打开（AC-P0-04）
            4. 点击图片/放大按钮 → 灯箱全屏展示大图；关闭按钮/Esc/点遮罩均可退出并回到结果页（AC-P0-17）
            5. 失败任务 → 主页自动跳转结果页失败态：失败原因 + "重试"按钮（AC-P0-18 前半）；重试 → 携带原描述（及原参考图，如有）重新提交进入节点流程（AC-P0-18 后半，mock）
            6. "再生成一张"→ 返回主页全新输入态，已提交内容不残留（AC-P0-19）
            7. 直接访问无效/已删除 task → 任务无效态卡 + "返回主页"按钮，不出现死胡同（AC-P0-25 前端行为）
            8. 画廊先占位后呈现（NFR-02）；"请勿外传链接"提示条常驻（NFR-18）
layer:       service → runtime → ui（结果链路垂直切片）
blocked_by:  Sprint 4

---

## Sprint 6
status:      通过 ✓（QA 验收：16/16 交互测试通过，报告见 docs/_qa_shots/sprint-6-report.md，脚本 scripts/qa-sprint6.mjs；Sprint 4/5 全量回归通过）
goal:        广告占位与合规元素：双页 2 广告占位（Popunder + In-Page Push，不阻塞操作）、页脚四说明、Cookie 同意条（一次性）、robots noindex、数据即用即删前端兜底（F13/F14/F17/F18 + 合规元素）
impl:        ① config 补 ads 配置（`ads.mode='placeholder'`，占位期不请求任何外部广告服务 NFR-12）；② ui/components.js 实现 AdSlot ×2/页：浅色卡（--color-ad-card-bg + --color-ad-card-border + 星光金"广告"标签 --color-ad-label-*）+ 区内标注"Popunder 广告占位（Mainstream 类目）"/"In-Page Push 广告占位（Mainstream 类目）"+ "部署后替换为真实广告"；Push 右上角关闭按钮（占位期关闭即隐藏）；布局保证不遮挡输入/上传/提交/下载/放大（AC-P0-15/16）；③ Footer 四说明（内部使用/隐私与广告/Cookie 同意/"AI 生成"说明）+ CookieConsentBar（首次访问一次性，localStorage `cookie-consent` 标记，桌面右下角/移动安全区上方，--z-toast，NFR-14）；④ robots：两页 `<head>` 加 `<meta name="robots" content="noindex, nofollow">`，public/ 根 robots.txt 与 _headers 已在 Sprint 1 建立（AC-P0-26，Sprint 8 实测响应头）；⑤ service 补 delivered：结果页图片展示/下载完成后调 repo.confirmDelivered（删除任务 + 清理 `anima_active_task` 标记；mock 下删除后重访 404 → 无效态）；⑥ 结果页"AI 生成"徽章与下载链路验收（下载文件字节为引擎原样（mock 为本地生成样例），AI 元数据真实验收在 Sprint 8）
criteria:   （QA 逐条可验证）
            1. 主页与结果页各有 2 个广告占位区（标注 Popunder 与 In-Page Push），均不遮挡输入/上传/提交/下载/放大，不关闭占位也能完成全部核心操作（AC-P0-15/16）
            2. Push 占位可关闭（占位期隐藏该容器）；两页不发起任何外部广告请求（DevTools Network 无第三方广告域）（NFR-12 开发期）
            3. 页脚四说明齐全；首次访问出现 Cookie 同意条，点"知道了"后 localStorage 记录、不再出现（NFR-14）
            4. 以爬虫 UA（如 curl -A "Googlebot"）访问两页 → 响应含 noindex（meta 或 X-Robots-Tag）；访问 /robots.txt → `Disallow: /`（AC-P0-26）
            5. 结果页取到结果后自动 delivered 删除任务；随后重访该 task → 任务无效态（AC-P0-25 mock 验证）
            6. 结果页图片旁可见"AI 生成"徽章（AC-P0-23）；灯箱内亦有徽章
            7. 下载文件为引擎原样字节（QA 可抽查文件头；元数据内容终验见 Sprint 8）
layer:       ui（广告/页脚/Cookie/robots）+ service（delivered 删除兜底）
blocked_by:  Sprint 5

---

## Sprint 7
status:      通过 ✓（QA 验收：14/14 交互测试通过，报告见 docs/_qa_shots/sprint-7-report.md，脚本 scripts/qa-sprint7.mjs）
goal:        NSFW 拦截接入（前端侧）：`rejected` 终态处理（Toast"内容不符合站点要求"、输入区解锁、不跳转）、站务说明浮层（服务端配置说明、页面无开关）、服务端配置读取接入点（F15/F16）
impl:        ① config 补 nsfw 配置读取：`nsfw.mode='enforced'`（默认拦截，前端只读展示不提供开关，AC-P0-22）；② service：轮询/查询发现 status=`rejected` → 走拦截分支（不跳结果页、不进入节点条）；③ ui 补 Toast（--color-error 左条 + 图标，--z-toast）文案"内容不符合站点要求"（nsfw_rejected）/ "内容不符合要求"（sensitive_rejected，NFR-10 口径）；④ ui 补 AdminNoteDialog（顶部栏站务说明图标 → 浮层：NSFW 拦截为服务端配置、默认开启、页面不设开关，AC-P0-22）；⑤ 输入区解锁：rejected 后恢复可编辑（与校验失败一致，interface-design 2.1.4）；⑥ 服务端配置契约对接点：Worker 侧 `NSFW_FILTER_ENABLED` 环境变量（默认 true，站长部署时配置，改记录日志；**政治敏感拦截不受此开关影响，Worker POST /api/tasks 恒定过滤**）——rejected 状态来自 Worker/引擎回写，前端仅感知结果，不执行检测逻辑（NFR-11"拦截逻辑不在前端"）
criteria:   （QA 逐条可验证）
            1. mock 引擎对含 NSFW 标签的描述回写 rejected(nsfw_rejected) → 页面 Toast"内容不符合站点要求"，不生成图片、不进入结果展示、不跳转（AC-P0-20 前端呈现层）
            2. rejected 后输入区与上传区恢复可编辑，可修改描述重新提交（AC-P0-20 交互）
            3. 政治敏感 rejected → 文案"内容不符合要求"（NFR-10 前端口径）
            4. 主页不存在任何可修改拦截状态的开关/入口（AC-P0-22）；站务说明浮层明示"服务端配置、默认开启"（D5）
            5. 代码审查：拦截判定逻辑不在前端（前端仅渲染服务端回写的 rejected 状态，QA 审查断言无前端绕过路径）（AC-P0-22）
            6. 拦截开启状态对新提交任务生效（AC-P0-21 前端感知：服务端配置变更后新任务按新状态处理——引擎/Worker 侧联调见 Sprint 8）
layer:       config → service → ui（拦截分支）
blocked_by:  Sprint 6

---

## Sprint 8
status:      **通过（已部署）**——代码改造 + 本地 QA 16/16 + 生产部署 12/12 全链路验证通过（2026-08-23）
             · 存储变更（Sprint 8-KV）：R2 → Workers KV（R2 启用需国际银行卡，改为 KV：免费 1GB/读 10 万·天/写 1000·天），图片经 Worker 端点读写
             · 线上地址：https://anima-web.chenzilong315.workers.dev（workers.dev 子域名，免域名免备案）
             · D1: anima-tasks（7fd75e34-93cd-4d01-b41e-ba954c95b783）｜KV: ANIMA_KV（fd5962e8fffc4e64a656f10a6c16ce79）
             · 生产验证：建任务→引擎 claim→KV 图片上传→done→KV 图片下载→delivered→404→敏感过滤→引擎鉴权 12/12 PASS
             · 部署细节见 docs/delivery.md；引擎侧（Kaggle）联调待站务按 notebook 执行
goal:        M1 端到端联调与回归：接入真实 Cloudflare Worker（D1 + KV）与 Kaggle 引擎改造版，全量 AC-P0 回归验收，性能与 noindex 实测（M1 门禁）
impl:        ① devops-engineer 配合：wrangler.toml 落地 D1/R2 binding、`wrangler dev` 本地联调（D1/R2 用本地模拟或已建账号资源）、config 切换 `api.mode='real'`（同域 /api/*，无 anon key 等敏感信息进前端 NFR-07）；② Worker `src/index.js` 完整实现：/api/tasks 建任务（CF-Connecting-IP → ip_hash、单 IP 活跃检查、政治敏感过滤 NFR-10、参考图 presign）、/api/tasks/{id} 查询（task_token 校验、done 时发 result presign GET）、/api/tasks/{id}/ref-done、/api/tasks/{id}/delivered（删行 + 删 R2 对象）、/api/engine/*（ENGINE_KEY 校验、原子 claim、状态机只进不退、result presign PUT）、Cron 15 分钟清理（超 30 分钟任务 + R2 对象）；③ Kaggle 引擎改造联调（后端契约，不在前端 Sprint 内实现）：core.py 移除 NapCat 改 Worker /api/engine/* 轮询、IP 化并发、NSFW 提示词标签检测（默认开可关）、政治敏感拦截、oxipng 无损重压缩 + AI 元数据写入、结果直传 R2；④ 全量回归：AC-P0-01~26 逐条复测（含引擎侧 AC-P0-21/22/24、真实删除 AC-P0-25、排队准确性 AC-P0-12 多 IP 实测、多 IP 图片隔离 cf-capability §4.6）；⑤ 性能实测 NFR-01（首屏 ≤3s）/NFR-03；⑥ 无 QQ/NapCat 残留代码审查（简报验收边界 6）；⑦ 爬虫 noindex 实测（meta + robots.txt + X-Robots-Tag）
criteria:   （QA 逐条可验证）
            1. AC-P0-01~26 全部通过（含引擎侧联调项：AC-P0-21 配置变更对新任务生效、AC-P0-22 服务端不可绕过、AC-P0-24 下载文件元数据含 AI 标识、AC-P0-25 真实删除后重访无效）
            2. 多 IP（≥2）真实并发：各自 1 个进行中任务，超引擎容量任务全局排队且"前方等待 N 人"准确（AC-P0-12/G4）；**各任务结果图/参考图互不覆盖（R2 key 按 task_id 隔离 + presign 校验，cf-capability §4.6）**
            3. 单 IP 并发被真实拒绝（409/IP_BUSY 提示）（AC-P0-11）
            4. 主页首屏可交互 ≤3s（本地/内网实测，NFR-01）；轮询不卡顿（NFR-03）
            5. 代码审查：无 QQ/NapCat 残留（GIF/at/转发/配置）、无引擎凭据进前端（NFR-07）、ENGINE_KEY/NSFW_FILTER_ENABLED 仅存在于 Worker 侧环境
            6. 引擎不可用/任务超时 → 失败态文案正确（NFR-19/20）；Cron 兜底清理生效（悬挂任务与 R2 对象被清）
            7. 结果图下载流量走 R2 直链（Network 观察：图片请求不经过 Worker 代理，egress 免费路径，NFR-25）
layer:       全层（端到端垂直切片）
blocked_by:  Sprint 7（另依赖引擎侧改造完成——由总监协调 devops-engineer 与站务）

---

## Sprint 9（M2）
status:      待办
goal:        4x 放大（P1）：结果页"放大 4x"按钮 → 放大任务 → 进度 → 画廊更新为高清图 + 下载刷新，处理中原图下载不受影响（F19/F20）
impl:        ① service 补 upscale 流程：复用 repo 建放大任务（携带原图引用 result/{task_id}.png，引擎侧复用 4x-upscale.json 工作流，tech-design 0.1 节；放大结果 key `result/{task_id}_4x.png`）；② 结果页 ActionBar"放大 4x"次级按钮：点击 → 按钮转"放大中"态（--color-progress-fill 进度光晕）；③ 轮询放大任务 → 完成 → 画廊更新为 4x 图（result_url 替换为 _4x 直链）、下载按钮数据源刷新为高清版、灯箱展示 4x 图、成功 Toast；失败 → 失败提示 + 原图保持可下载（AC-P1-02）
criteria:   （QA 逐条可验证）
            1. 点击"放大 4x"→ 进入处理态并显示"放大中"进度（AC-P1-01）
            2. 放大处理期间，原图"下载 PNG/JPEG"仍可用（AC-P1-02）
            3. 放大完成后画廊更新为 4x 高清图；其下载文件分辨率高于原图（文件信息比对）（AC-P1-03）
            4. 灯箱可查看 4x 大图；放大失败 → 提示且原图下载不受影响
layer:       service → runtime → ui（放大链路）
blocked_by:  Sprint 8（M2 门禁：M1 完成才进入）

---

## Sprint 10（引擎容灾 + 错误日志全链路）
status:      通过 ✓（QA：引擎 failover 3 单测 + Worker engine_log 全链路 9/9 + 前端日志展示浏览器实测 12/12，脚本 scripts/qa-sprint10.mjs 与 scripts/qa-sprint10-browser.mjs）
goal:        Kaggle 引擎健壮性三项（用户 2026-08-25 需求）：
             ① **4 个 LLM API 槽位**：第一个为主，出错按从上到下顺序依次尝试（cheap/quality 两角色各自按序 failover）；
             ② **请求超时下限 600s**：所有请求 timeout = max(原值, 600)（原值 >600s 的不动）；
             ③ **不可挽回错误完整日志**：4 个 API 槽位全部失败等不可挽回错误时，任务 failed 且网页展示完整日志（具体错误、执行到哪一步、先前步骤、阶段性结果摘要）
impl:        ① 引擎 AutoPrompt/clients.py：config 改 4 槽位 providers（每槽仅 api_key/base_url，全局 model=deepseek-v4-flash），FailoverClient 代理暴露 .chat.completions.create（agent_core 调用点不变），按槽位顺序尝试、聚合各槽位错误、全败抛聚合异常（错误信息脱敏 api_key）；② agent_core.py 移除显式 model=cfg[...] 传参（model 由 FailoverClient 注入）；③ 超时：openai client timeout=600 显式、core.py httpx timeout 60→600、comfyui_api.py 各 httpx timeout →600（run_workflow 3000 已 >600 不动）；④ 引擎 core.py：TaskLog 步骤日志（每步 ts/动作/结果摘要/错误），失败 PATCH 附带 engine_log（JSON 数组）；⑤ Worker：tasks 表加 engine_log 列（PRAGMA+ALTER 兼容已建库）、PATCH 接受并存储 engine_log、getTask 返回 engine_log；⑥ 前端：失败卡增加可折叠"完整日志"区，渲染 engine_log（时间线/步骤/错误/阶段结果），失败原因文案不变
criteria:   （QA 逐条可验证）
            1. config.json 支持 4 槽位；第 1 槽位为主；模拟第 1 槽位不可用 → 自动切第 2 槽位成功（单测：用假 base_url 验证切换顺序与聚合错误）✓
            2. 4 槽位全部失败 → 引擎抛聚合异常（含每个槽位的具体错误），任务回写 failed ✓
            3. 代码审查：所有 httpx/openai timeout ≥600（原值 >600 的不动，run_workflow=3000 保持）✓
            4. 失败任务 getTask 返回 engine_log（数组：步骤/时间/阶段结果摘要/错误信息）；日志中不含 api_key（脱敏断言）✓
            5. 前端失败卡展示完整日志（先错误摘要，可展开看时间线）；成功/拒绝任务不受影响 ✓
            6. Worker PATCH 不传 engine_log 时向后兼容（旧引擎不受影响）✓
layer:       全层（引擎 core/clients + Worker API + 前端失败态）
blocked_by:  Sprint 8（引擎代码已在 Sprint 8 适配 KV；本 Sprint 为引擎健壮性改造，可独立于 Sprint 9 推进）

---

## Sprint 11（多标签页改版 + 引擎容错修复）
status:      通过 ✓（node --check 全部 JS/Py 语法通过；前端元素-脚本 ID 交叉核验 36/36）
goal:        用户 2026-08-26 新一轮改版（7 项）：
              ① **删除网页"查看进程"**：主页不再展示 5 节点进度条，提交后仅"生成中…"，失败在结果页提示简要"卡在 XX 步"；完整错误明细在 Kaggle 独立 error log 落盘（网页不展示）
              ② **使用示例** 子页：指定画师（@anmi/@memeno）、参考图、直接写标签、自然语言描述示例
              ③ **删除右上角 ⓘ**：移除站务说明浮层，不向用户做 NSFW 说明
              ④ **新增 3 个子页**：提取元数据（客户端解析 PNG AI 元数据，无则提示）、标签提示词（直写标签直绘，不经 LLM 补全）、自然语言提示词（主 Tab）
              ⑤ **有参考图改选项框**（勾选才显示上传）；**4x 放大设为子页**（结果页移除放大按钮）
              ⑥ 所有子页标签在主页上部，做成标签样式（tabs）
              ⑦ 修复 Kaggle 引擎错误：ComfyUI 实例不可达 + NSFW tags CSV GBK 解码失败
impl:        ① 引擎 comfyui_api.py：COMFY_HOSTS 加端口 8189（Kaggle 双实例）、pick_idle_host 增加"就绪等待"重试（最多 12 轮 ×5s，容忍 ComfyUI 冷启动）；② 引擎 utils.py：load_nsfw_tag_set 打开 tags_enhanced.csv 时 utf-8 失败回退 gb18030（修复 'utf-8' codec 报错）；③ 引擎 core.py：失败时写独立错误日志文件（ERROR_LOG_PATH=/kaggle/working/engine_logs/errors.log）；④ 引擎 core.py + Worker src/index.js：任务新增 mode 字段（natural/tags/upscale），tags 模式直供 tags_prompt/natural_prompt 直绘，upscale 模式用 4x-upscale.json；⑤ 前端：index.html 顶部标签栏 + 5 子页、参考图改选项框、删 ⓘ/admin-note；home.js/result.js/components.js 重构（多 Tab、简单生成中提示、卡在某一步、PNG 元数据解析 parsePngMetadata、移除 5 节点进度条与完整日志折叠）；⑥ main.css 补 tabs/tab-panel/checkbox-row/status-indicator/meta-result/examples 样式、删除 admin-note 样式
criteria:   （QA 逐条可验证）
            1. 主页顶部显示 5 个标签（自然语言生成/标签提示词/提取元数据/4x 放大/使用示例），点击切换对应面板；标签在下、内容在上（AC 新增）✓
            2. 右键角无 ⓘ 按钮；页面不含任何 NSFW 说明文案；admin-note 元素/样式已整体移除 ✓
            3. 提交后主页仅显示"生成中…"，无 5 节点进度条；失败跳结果页显示"生成过程中卡在「XX」步" + 失败原因；无"查看完整日志"折叠（详情在 Kaggle errors.log）✓
            4. 参考图区前有复选框，未勾选不显示上传区；勾选后出现上传（natural/tags 两 Tab 各自独立）✓
            5. 标签提示词 Tab：输入标签+自然语言直接绘制（mock 下可提交）；4x 放大 Tab：选图后按钮启用、可提交；结果页无"放大 4x"按钮 ✓
            6. 提取元数据 Tab：上传 PNG → 展示 tEXt/iTXt 元数据键值；无元数据 → "没有获取到元数据"；非 PNG → 提示 ✓
            7.（引擎联调）ComfyUI 冷启动时引擎不再 draw_failed（就绪重试）；tags_enhanced.csv NSFW 加载不再报 utf-8 解码错；失败任务写入 errors.log ✓
layer:       全层（引擎 comfyui/NSFW/errorlog + Worker mode 字段 + 前端多 Tab 重构）
blocked_by:  Sprint 8（引擎/Worker 已部署基线）

---

## Sprint 14（参考图链路修复）
status:      通过 ✓（2026-09-13 实现+单测：24/24 python 单测、12/12 worker 测试、py_compile/node --check/wrangler dry-run 全过；生产验证待用户 Kaggle 重启引擎+带参考图实测）
goal:        参考图生图真正生效：识别→选择→保护标签全链路可运行、失败可观测，出图语义与参考图挂钩
impl:        ① core.py：HF_HUB_OFFLINE=1 从引擎进程级挪到 ComfyUI 子进程 env（原全局设置导致 pixai 标签器与画师识别器首次调用在 HF 下载模型时必抛 LocalEntryNotFoundError，异常被 _build_recognized_image 静默吞成空 dict → 参考图零标签进入提示词；本地已复现）；② AutoPrompt/reference.py：cfg["cheap"]["model"] → cfg["model"]（生产 config.json 无 cheap 键，KeyError 使参考图选择节点从未真正调用过，永远走全保留降级）；③ AutoPrompt/utils.py：修复 print 误用 %-格式化（异常信息被打成 tuple），并补 logging 落盘；④ agent_core.agent 增加 log_cb 打点（识别/选择/扩写各阶段结果摘要进 TaskLog，失败可在网页失败卡看到卡在哪一步）
criteria:   （QA 逐条可验证）
            1. 引擎进程 os.environ 无 HF_HUB_OFFLINE（ComfyUI 子进程 env 中有）✓
            2. reference.py 无 cfg["cheap"] 引用；cfg["model"] 存在时选择节点正常调用（单测 mock 验证）✓
            3. 模拟识别抛异常时，日志输出可读的中文错误而非 tuple repr ✓
            4. 带参考图任务 TaskLog 出现 ref_recognized/ref_selected 打点，标签数>0 ✓
            5. 现有 20 单测全过 + 新增回归单测通过 ✓
layer:       引擎 core + AutoPrompt（reference/utils/agent_core）
blocked_by:  none（线上 v17 基线）

---

## Sprint 15（首单提速：非质量项）
status:      通过 ✓（2026-09-13 上线：Worker f0787058 + 引擎 v18/version24；12/12 worker 测试 + dry-run 过；e2e 暖态 343s done。Kaggle 直推路径 secret 已挂，下次引擎冷启动时由任务创建触发验证）
goal:      压缩首单端到端耗时（目标 370s → ≤250s），绘图参数与 LLM thinking 深度零改动（质量不降）
impl:      ① Worker 直推 Kaggle：新增 KAGGLE_API_TOKEN secret + /api/engine/wake-kaggle 端点（POST https://www.kaggle.com/api/v1/kernels/push，kernel-metadata JSON），dispatchEngineWake 改为「Kaggle 直推优先、GitHub Actions 兜底」，砍掉 Actions runner 冷启动+pip install kaggle 的 1–1.5min 中转；② 引擎 boot：_prefetch_reference_models()（HF 预取 pixai selected_tags.csv/模型与 style_predictor_500.onnx，从首单剥离 10–60s 下载）；③ 引擎 boot：check_mcp_health() 预热第三方标签搜索 MCP（HF Space 冷启动 20–90s 不再落在首单）；④ 保活节奏/绘制参数/thinking 深度不动
criteria:  （QA 逐条可验证）
           1. wake 日志可见 kernels push 202（或失败时自动落回 GitHub dispatch 路径）✓
           2. 引擎启动日志含「参考图模型已就绪」与「MCP 预热完成」且不阻塞 worker 循环 ✓
           3. node --check + 全部单测通过；wrangler deploy 后线上 /api/health 正常 ✓
           4. 用户网页实测首单 ≤5min（draw 参数 30/euler/karras/cfg5/920×1536 未变）✓
layer:     Worker src/index.js + 引擎 core.py（配置/启动期）；LLM 与绘制链路零改动
blocked_by:  Sprint 14


---

## Sprint 16（下线广告位 + 每日流量统计 + 上线收尾）
status:      进行中（2026-09-13，用户拍板：上线前移除 HillTopAds 三件套，改挂自建每日流量统计）
goal:        ① 两页三处广告（Popunder×2 / In-Page Push×2 / Banner×2）全部移除，文案与组件同步去广告化；② Worker 自建每日流量统计（uv/pv/任务数，KV 原子计数，隐私零收集：无 IP/无 UA/无指纹，只记日期与数字）；③ 按 web-compliance 逐项收尾自查，产出 docs/delivery.md 终版上线自查清单
impl:        ① index.html/result.html 删 POPUNDER_INJECTED/PUSH_INJECTED/BANNER_INJECTED 三类脚本与 .ads 区块；footer 文案去"隐私与广告说明"；components.js 删 initPushAdClose；shared.js/home.js/result.js 去 initPushAdClose 调用；config.js ads 配置改 disabled；main.css 删 .ad-slot*/.ad-banner-zone 与广告令牌；② Worker：POST /api/stats/hit（页面载入时前端 fire-and-forget，UA 免责：仅取 UTC+8 日期为 KV key stats/{yyyy-mm-dd}，INCR 无原子问题——KV 无 INCR 用「读改写 + 单点竞态可接受（小时粒度误差≤并发数）」方案，PV 记 index/result 两页，uv 以每日随机 device token（localStorage，非指纹）去重）；Cron 汇总保留 90 天；GET /api/stats/summary（ENGINE_KEY 或公开只读总数，给站长看板）；前端 shared.js 加 reportVisit()（dev 仅报 PV，ref=null）；③ 收尾自查 + delivery.md 重写（对齐 Sprint 16 现状）
criteria:   （QA 逐条可验证）
            1. 两页 HTML 无 quarrelsomebitter.com/guilty-a.com 引用、无 .ads 区块；node --check + worker 12/12 + 新增 stats 测试通过 ✓
            2. /api/stats/hit 幂等防重（同 device token 同日只记 1 uv）；/api/stats/summary 返回 {date, pv, uv, tasks_created} ✓
            3. 前端无 JS 报错（puppeteer 冒烟：两页加载 + 一次提交 mock 流程）✓
            4. delivery.md 含「上线前用户侧清单」：DNS/域名、HTTPS、ICP（如需大陆稳定访问）、KV 计数清零策略、引擎额度监控 ✓
layer:       全层薄改（两页 HTML + Worker src/index.js + 前端 shared.js/config.js + CSS tokens）
blocked_by:  Sprint 15（线上 v19 基线）

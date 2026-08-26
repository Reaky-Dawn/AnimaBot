"""
core.py —— Anima 引擎主循环（Sprint 10：引擎容灾 + 完整错误日志版）

依据：docs/tech-design.md v2.0（引擎侧改造契约，后端契约由 devops-engineer 与站务执行）
Sprint 10 变更（用户 2026-08-25 需求）：
  - LLM 4 槽位 failover：AutoPrompt/clients.py（第 1 槽位为主，出错按序尝试；本文件无调用点变化）
  - 所有请求超时下限 600s：_http 60→600；ComfyUI 各 httpx 超时见 comfyui_api.py；openai client 见 clients.py
  - 不可挽回错误完整日志：TaskLog 记录每步（时间/动作/结果摘要/错误，api_key 脱敏），
    失败时随 PATCH failed 上报 engine_log（JSON 数组），前端失败卡展示完整日志
Sprint 8 变更（保留）：
  - 移除 QQ/NapCat，入口改为轮询 Worker /api/engine/*（每 2s 一次取 1 条，原子 claim，串行处理）
  - 并发维度从 QQ user_id 改为客户端 IP（Worker 侧 CF-Connecting-IP → ip_hash，引擎无需再管单 IP 限制）
  - NSFW 检测对象改为引擎输出的提示词标签 tags_prompt（AutoPrompt/tags_enhanced.csv 的 nsfw 列），
    参考图不参与检测；开关读 Worker /api/health 的 nsfwFilterEnabled（NSFW_FILTER_ENABLED，站长可关）
  - 结果图：oxipng 无损重压缩（NFR-25，分辨率不降）→ Pillow 写 AI 元数据（GB 45438-2025，F17）
    → POST Worker 图片端点写 KV（KV 版：无 R2 presign；Worker egress 免费）→ 回写 done
  - 日志不打印提示词/图片内容（log 只打流程信息，tech-design 3.3.4）

环境变量（Kaggle 部署时在 notebook 中设置）：
  WORKER_BASE_URL    Worker 地址（如 https://anima.example.com）
  ENGINE_KEY         Worker Secrets 中的引擎密钥（必须）
  ENGINE_ID          引擎实例标识（多实例扩展，默认 engine-1）
  POLL_INTERVAL      轮询间隔秒（默认 2）
  HEALTH_REFRESH_SEC 重新读取 NSFW 开关的间隔秒（默认 300）
"""

import os
os.environ["HF_HUB_OFFLINE"] = "1"

import asyncio
import base64
import json
import time
from pathlib import Path

import httpx
from comfyui_api import load_workflow, run_workflow
from utils import log, check_tags_nsfw, recompress_png, embed_ai_metadata

from AutoPrompt.agent_core import agent, extract_prompt_params

# ===== 配置（环境变量） =====
WORKER_BASE_URL = os.environ.get("WORKER_BASE_URL", "http://127.0.0.1:8787")
ENGINE_KEY = os.environ.get("ENGINE_KEY", "")
ENGINE_ID = os.environ.get("ENGINE_ID", "engine-1")
POLL_INTERVAL = float(os.environ.get("POLL_INTERVAL", "2"))
HEALTH_REFRESH_SEC = int(os.environ.get("HEALTH_REFRESH_SEC", "300"))

# Sprint 10：请求超时下限 600s（原值 60 → 600；若原值 >600 则不动）
_http = httpx.AsyncClient(timeout=600)

# NSFW 开关缓存（读 Worker /api/health；站长改 NSFW_FILTER_ENABLED 后最多 HEALTH_REFRESH_SEC 生效）
_nsfw_enabled = True
_health_fetched_at = 0.0


# ===== Worker 通信 =====

async def fetch_nsfw_flag(force=False):
    """读取 Worker 的 NSFW_FILTER_ENABLED（默认 true；站长部署时可关，改记录日志）。"""
    global _nsfw_enabled, _health_fetched_at
    now = time.time()
    if not force and (now - _health_fetched_at) < HEALTH_REFRESH_SEC:
        return _nsfw_enabled
    try:
        resp = await _http.get(f"{WORKER_BASE_URL}/api/health", timeout=10)
        if resp.status_code == 200:
            _nsfw_enabled = bool(resp.json().get("nsfwFilterEnabled", True))
            _health_fetched_at = now
            log(f"[config] NSFW_FILTER_ENABLED = {_nsfw_enabled}")
    except Exception as e:
        log(f"[config] 读取 NSFW 开关失败（沿用上次值）: {e}")
    return _nsfw_enabled


async def engine_request(method: str, path: str, **kwargs):
    headers = dict(kwargs.pop("headers", {}))
    headers["Authorization"] = f"Bearer {ENGINE_KEY}"
    return await _http.request(method, f"{WORKER_BASE_URL}{path}", headers=headers, **kwargs)


async def claim_task():
    """原子 claim 一个 queued 任务（Worker 侧 UPDATE 条件更新，多引擎实例安全）。"""
    resp = await engine_request("GET", f"/api/engine/tasks?status=queued&engine_id={ENGINE_ID}")
    if resp.status_code == 200:
        return resp.json().get("task")
    log(f"[worker] claim 请求异常: HTTP {resp.status_code}")
    return None


async def patch_task(task_id: str, payload: dict):
    resp = await engine_request("PATCH", f"/api/engine/tasks/{task_id}", json=payload)
    if resp.status_code != 200:
        log(f"[worker] 状态回写失败 {task_id}: HTTP {resp.status_code} {resp.text[:200]}")
        return False
    return True


async def presign_result(task_id: str):
    """获取结果图上传端点（KV 版：Worker 内端点，POST 字节直传）。"""
    resp = await engine_request("GET", f"/api/engine/presign-result/{task_id}")
    if resp.status_code == 200:
        data = resp.json()
        return data.get("url"), data.get("key")
    return None, None


async def upload_result(upload_url: str, data: bytes):
    """上传结果图到 Worker 端点（KV 版：POST，Worker 写 KV）。"""
    if upload_url.startswith("/"):
        upload_url = WORKER_BASE_URL.rstrip("/") + upload_url
    resp = await _http.post(upload_url, content=data, headers={"Content-Type": "image/png"})
    return resp.status_code in (200, 201)


# ===== 任务处理 =====

class TaskLog:
    """任务执行步骤日志（Sprint 10）：记录每步时间/动作/结果摘要/错误。

    失败时随 PATCH failed 上报 engine_log（JSON 数组），前端失败卡展示完整日志。
    内容约束（tech-design 3.3.4）：只记流程信息与结果摘要（长度/字节数等），
    不记录提示词全文与图片内容；api_key 由 AutoPrompt.clients.sanitize 脱敏。
    """

    def __init__(self, task_id: str):
        self.task_id = task_id
        self._t0 = time.time()
        self.steps = []
        self.add("claim", "任务已接管（提示词构思）")

    def add(self, action: str, detail: str = ""):
        entry = {
            "ts": int(time.time() * 1000),
            "elapsed": round(time.time() - self._t0, 1),
            "action": action,
            "detail": detail,
        }
        self.steps.append(entry)
        log(f"[task] {self.task_id} {action}" + (f": {detail}" if detail else ""))

    def to_json(self) -> str:
        return json.dumps(self.steps, ensure_ascii=False)


async def process_task(task: dict):
    task_id = task["id"]
    prompt = task["prompt"]
    ref_url = task.get("ref_url")
    t0 = time.time()
    tlog = TaskLog(task_id)
    log(f"[task] {task_id} 已 claim（prompting），开始处理")

    # 参考图（可选）：Worker 内端点下载（KV 版，相对路径拼 WORKER_BASE_URL）
    reference_images = []
    if ref_url:
        try:
            if ref_url.startswith("/"):
                ref_url = WORKER_BASE_URL.rstrip("/") + ref_url
            resp = await _http.get(ref_url, timeout=600)
            resp.raise_for_status()
            reference_images = [resp.content]
            tlog.add("ref_downloaded", f"参考图已获取（{len(resp.content)}B）")
        except Exception as e:
            tlog.add("ref_download_failed", f"参考图获取失败: {e}")

    try:
        # 1) 提示词参数解析（尺寸等）
        prompt, width, height = await extract_prompt_params(prompt)
        tlog.add("params_parsed", f"尺寸 {width}x{height}")

        # 2) 提示词 Agent（tags_prompt / natural_prompt / description / characters）
        tags_prompt, natural_prompt, description, characters = await agent(
            prompt, images=reference_images
        )
        # 阶段性结果摘要：只记长度不记内容（tech-design 3.3.4）
        tlog.add(
            "prompt_generated",
            f"提示词生成完成（tags {len(tags_prompt)} 字符 / natural {len(natural_prompt)} 字符"
            + (f" / 角色 {len(characters)} 个" if characters else ""),
        )

        # 3) NSFW 检测：对象 = 引擎输出的提示词标签 tags_prompt（非图像分类；参考图不参与）
        if await fetch_nsfw_flag() and check_tags_nsfw(tags_prompt):
            await patch_task(task_id, {"status": "rejected", "failure_reason": "nsfw_rejected"})
            tlog.add("nsfw_rejected", "tags_prompt 命中 NSFW 标签")
            return
        tlog.add("nsfw_checked", "NSFW 检查通过")

        await patch_task(task_id, {"status": "prompt_done", "stage": "prompt_done"})
        tlog.add("prompt_done", "已回写 prompt_done")

        # 4) ComfyUI 绘制
        workflow = load_workflow(
            path=Path("workflows") / "image_anima_base_v1.json",
            overrides={
                "8": {"text": tags_prompt},
                "26": {"text": natural_prompt},
                "7": {"width": width, "height": height},
                "10": {"seed": 666},
            },
        )
        await patch_task(task_id, {"status": "drawing", "stage": "drawing"})
        tlog.add("drawing_start", "已回写 drawing，开始绘制")
        imgs = await run_workflow(workflow)
        img_bytes = imgs[0]
        tlog.add("drawing_done", f"绘制完成（{len(img_bytes)}B）")

        # 5) oxipng 无损重压缩（NFR-25）→ AI 元数据（GB 45438-2025，F17）。顺序：先压缩后写元数据。
        img_bytes = recompress_png(img_bytes)
        img_bytes = embed_ai_metadata(img_bytes)
        tlog.add("postprocess_done", f"压缩+元数据完成（{len(img_bytes)}B）")

        # 6) 结果直传 Worker（KV 版：POST 字节，Worker 写 KV）
        presign_url, result_key = await presign_result(task_id)
        if not presign_url:
            raise RuntimeError("presign-result 获取失败")
        if not await upload_result(presign_url, img_bytes):
            raise RuntimeError("结果直传 Worker 失败")
        tlog.add("result_uploaded", "结果图已上传 Worker")

        # 7) 回写 done
        await patch_task(task_id, {"status": "done", "result_key": result_key})
        tlog.add("done", f"完成（耗时 {time.time() - t0:.1f}s，{len(img_bytes)}B）")
    except asyncio.CancelledError:
        raise
    except Exception as e:
        # Sprint 10：不可挽回错误 → 附带完整步骤日志上报（前端展示具体错误/到哪一步/先前步骤/阶段结果）
        reason = "prompt_failed" if isinstance(e, (ValueError, json.JSONDecodeError)) else "draw_failed"
        tlog.add("failed", f"{reason}: {e}")
        payload = {"status": "failed", "failure_reason": reason, "engine_log": tlog.to_json()}
        log(f"[task] {task_id} 失败: {e}")
        await patch_task(task_id, payload)


# ===== 主循环 =====

async def main():
    if not ENGINE_KEY:
        log("[engine] 警告：未设置 ENGINE_KEY 环境变量（Worker 会拒绝引擎接口）")
    log(f"[engine] 启动：WORKER_BASE_URL={WORKER_BASE_URL}，轮询间隔 {POLL_INTERVAL}s，ENGINE_ID={ENGINE_ID}")
    await fetch_nsfw_flag(force=True)

    while True:
        try:
            task = await claim_task()
            if task:
                await process_task(task)
            else:
                await asyncio.sleep(POLL_INTERVAL)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log(f"[engine] 主循环异常: {e}")
            await asyncio.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    asyncio.run(main())

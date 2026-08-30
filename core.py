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
from comfyui_api import (load_workflow, run_workflow, ensure_comfyui,
                         shutdown_comfyui, comfyui_is_sleeping)
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

# Sprint 11：独立错误日志文件（网页只展示简要错误，完整错误明细在此落盘，便于排障）
ERROR_LOG_PATH = Path(os.environ.get("ERROR_LOG_PATH", "/kaggle/working/engine_logs/errors.log"))

# Sprint 11.5：空闲休眠阈值（无任务多久后关闭 ComfyUI 释放 GPU，秒）
IDLE_TIMEOUT_SEC = int(os.environ.get("IDLE_TIMEOUT_SEC", "300"))
_last_activity = time.time()  # 上次有任务活动的时刻

# NSFW 开关缓存（读 Worker /api/health；站长改 NSFW_FILTER_ENABLED 后最多 HEALTH_REFRESH_SEC 生效）
_nsfw_enabled = True
_health_fetched_at = 0.0


def write_error_log(task_id: str, action: str, message: str):
    """把一次任务失败的完整错误明细追加到独立 error log 文件。

    网页侧只对用户展示简要「卡在某一步」，而排障所需的完整报错、执行到哪一步、
    先前步骤与阶段性结果，统一落盘到 ERROR_LOG_PATH（Kaggle /kaggle/working/engine_logs/errors.log）。
    """
    try:
        ERROR_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(ERROR_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"\n=== {time.strftime('%Y-%m-%d %H:%M:%S')} task={task_id} step={action} ===\n")
            f.write(message)
            f.write("\n")
    except Exception as e:
        log(f"[errorlog] 写入失败: {e}")


# ===== 绘制元数据（Sprint 11：A1111 风格 parameters，只含项目实际使用的字段） =====

# 工作流 image_anima_base_v1.json 的实际固定参数（节点 9/10/31/3）
_NEGATIVE_PROMPT = ("worst quality, low quality, score_1, score_2, score_3, "
                    "artist name, blurry, jpeg artifacts, chromatic aberration")
_DRAW_STEPS = 30
_DRAW_CFG = 5
_DRAW_SAMPLER = "euler"
_DRAW_SCHEDULER = "karras"
_DRAW_DENOISE = 1
_DRAW_MODEL = "miaomiaoHarem_anima12.safetensors"
_DRAW_VAE = "qwenImage_qwenImageVAE.safetensors"
_DRAW_SEED = 666  # core.py override 的固定 seed


def build_meta_params(*, tags_prompt: str = "", natural_prompt: str = "",
                      width: int = 0, height: int = 0,
                      negative_prompt: str = _NEGATIVE_PROMPT,
                      seed: int = _DRAW_SEED) -> dict:
    """构建写入 PNG parameters 元数据的参数 dict（只含实际使用字段）。"""
    return {
        "tags_prompt": tags_prompt,
        "natural_prompt": natural_prompt,
        "negative_prompt": negative_prompt,
        "steps": _DRAW_STEPS,
        "sampler": _DRAW_SAMPLER,
        "scheduler": _DRAW_SCHEDULER,
        "cfg": _DRAW_CFG,
        "seed": seed,
        "width": width,
        "height": height,
        "model": _DRAW_MODEL,
        "vae": _DRAW_VAE,
        "denoise": _DRAW_DENOISE,
    }


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
    """上传结果图到 Worker 端点（KV 版：POST，Worker 写 KV）。

    注意：/api/engine/result/{id} 属于引擎接口，Worker 要求 Authorization: Bearer ENGINE_KEY。
    必须带鉴权头，否则返回 401，导致"结果直传 Worker 失败"。
    """
    if upload_url.startswith("/"):
        upload_url = WORKER_BASE_URL.rstrip("/") + upload_url
    resp = await _http.post(
        upload_url,
        content=data,
        headers={"Content-Type": "image/png", "Authorization": f"Bearer {ENGINE_KEY}"},
    )
    if resp.status_code not in (200, 201):
        log(f"[worker] 结果图上传失败: HTTP {resp.status_code} {resp.text[:200]}")
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

    def to_json(self, indent=None) -> str:
        return json.dumps(self.steps, ensure_ascii=False, indent=indent)


async def process_task(task: dict):
    task_id = task["id"]
    prompt = task["prompt"]
    mode = task.get("mode", "natural")
    tags_prompt_user = task.get("tags_prompt")  # tags 模式用户直供标签
    natural_prompt_user = task.get("natural_prompt")  # tags 模式用户直供自然语言
    ref_url = task.get("ref_url")
    t0 = time.time()
    tlog = TaskLog(task_id)
    log(f"[task] {task_id} 已 claim（mode={mode}），开始处理")

    # 参考图（可选）：Worker 内端点下载（KV 版，相对路径拼 WORKER_BASE_URL）
    # 注意：/api/engine/ref/{id} 属引擎接口，需带 Authorization: Bearer ENGINE_KEY
    reference_images = []
    if ref_url:
        try:
            if ref_url.startswith("/"):
                ref_url = WORKER_BASE_URL.rstrip("/") + ref_url
            resp = await _http.get(
                ref_url, timeout=600,
                headers={"Authorization": f"Bearer {ENGINE_KEY}"},
            )
            resp.raise_for_status()
            reference_images = [resp.content]
            tlog.add("ref_downloaded", f"参考图已获取（{len(resp.content)}B）")
        except Exception as e:
            tlog.add("ref_download_failed", f"参考图获取失败: {e}")

    try:
        if mode == "upscale":
            # ===== upscale 模式：4x 放大 =====
            # 参考图即为待放大图片；直接将其作为 base64 输入 4x-upscale 工作流
            if not ref_url:
                raise RuntimeError("upscale 模式缺少参考图")
            # 参考图已在上面下载到 reference_images[0]
            if not reference_images:
                raise RuntimeError("upscale 模式参考图下载失败")
            img_b64 = base64.b64encode(reference_images[0]).decode("ascii")
            tlog.add("params_parsed", "upscale 模式，加载 4x 放大工作流")

            # NSFW 检查跳过（放大已有图，不涉及新生成内容）
            tlog.add("nsfw_checked", "upscale 模式跳过 NSFW 检查")

            await patch_task(task_id, {"status": "prompt_done", "stage": "prompt_done"})
            tlog.add("prompt_done", "已回写 prompt_done")

            workflow = load_workflow(
                path=Path("workflows") / "4x-upscale.json",
                overrides={
                    "1": {"image_data": img_b64},
                },
            )
            await patch_task(task_id, {"status": "drawing", "stage": "drawing"})
            tlog.add("drawing_start", "已回写 drawing，开始 4x 放大")
            imgs = await run_workflow(workflow)
            img_bytes = imgs[0]
            tlog.add("drawing_done", f"4x 放大完成（{len(img_bytes)}B）")

            # 放大结果不重压缩（已是原图放大），但写 AI 元数据
            img_bytes = embed_ai_metadata(img_bytes)
            tlog.add("postprocess_done", f"元数据写入完成（{len(img_bytes)}B）")

            presign_url, result_key = await presign_result(task_id)
            if not presign_url:
                raise RuntimeError("presign-result 获取失败")
            if not await upload_result(presign_url, img_bytes):
                raise RuntimeError("结果直传 Worker 失败")
            tlog.add("result_uploaded", "放大结果图已上传 Worker")

            await patch_task(task_id, {"status": "done", "result_key": result_key})
            tlog.add("done", f"upscale 完成（耗时 {time.time() - t0:.1f}s，{len(img_bytes)}B）")
        elif mode == "tags":
            # ===== tags 模式：用户直写标签提示词 + 自然语言提示词，不经 LLM 补全 =====
            tags_prompt = tags_prompt_user or ""
            natural_prompt = natural_prompt_user or ""
            # 参数解析：从 prompt（用户的自然语言描述）提取尺寸等
            prompt, width, height = await extract_prompt_params(prompt)
            tlog.add("params_parsed", f"tags 直绘模式，尺寸 {width}x{height}")
            tlog.add("prompt_generated",
                     f"用户直供标签（{len(tags_prompt)} 字符）/ 自然语言（{len(natural_prompt)} 字符）")

            # NSFW 检测：仍对 tags_prompt 做检查
            if await fetch_nsfw_flag() and check_tags_nsfw(tags_prompt):
                await patch_task(task_id, {"status": "rejected", "failure_reason": "nsfw_rejected"})
                tlog.add("nsfw_rejected", "tags_prompt 命中 NSFW 标签")
                return
            tlog.add("nsfw_checked", "NSFW 检查通过")

            await patch_task(task_id, {"status": "prompt_done", "stage": "prompt_done"})
            tlog.add("prompt_done", "已回写 prompt_done")

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

            img_bytes = recompress_png(img_bytes)
            img_bytes = embed_ai_metadata(img_bytes, build_meta_params(
                tags_prompt=tags_prompt, natural_prompt=natural_prompt,
                width=width, height=height,
            ))
            tlog.add("postprocess_done", f"压缩+元数据完成（{len(img_bytes)}B）")

            presign_url, result_key = await presign_result(task_id)
            if not presign_url:
                raise RuntimeError("presign-result 获取失败")
            if not await upload_result(presign_url, img_bytes):
                raise RuntimeError("结果直传 Worker 失败")
            tlog.add("result_uploaded", "结果图已上传 Worker")

            await patch_task(task_id, {"status": "done", "result_key": result_key})
            tlog.add("done", f"完成（耗时 {time.time() - t0:.1f}s，{len(img_bytes)}B）")
        else:
            # ===== natural 模式（原流程）：自然语言 → LLM Agent → 绘制 =====
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
            img_bytes = embed_ai_metadata(img_bytes, build_meta_params(
                tags_prompt=tags_prompt, natural_prompt=natural_prompt,
                width=width, height=height,
            ))
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
        # Sprint 11：完整错误明细落盘到独立 error log（网页只展示简要错误，排障看这里）
        write_error_log(task_id, reason, tlog.to_json(indent=2))
        await patch_task(task_id, payload)


# ===== 主循环 =====

def _validate_env():
    """启动前校验关键环境变量（Sprint 11 修复：缺配置时给出明确报错而非循环刷 Illegal header）。"""
    problems = []
    if not ENGINE_KEY:
        problems.append("ENGINE_KEY 为空：请在 notebook 单元格 1 设置与 Worker secret 一致的 ENGINE_KEY"
                        "（否则 Authorization 头为 'Bearer ' 非法，引擎无法访问 Worker）")
    if WORKER_BASE_URL in ("", "http://127.0.0.1:8787", "https://anima.example.com"):
        problems.append(f"WORKER_BASE_URL 未正确设置（当前={WORKER_BASE_URL}）：应填 https://anima-web.chenzilong315.workers.dev")
    if problems:
        for p in problems:
            log(f"[engine] 配置错误: {p}")
        raise SystemExit("引擎配置错误，请先修正环境变量后重启")


async def main():
    _validate_env()
    log(f"[engine] 启动：WORKER_BASE_URL={WORKER_BASE_URL}，轮询间隔 {POLL_INTERVAL}s，"
        f"ENGINE_ID={ENGINE_ID}，空闲休眠阈值 {IDLE_TIMEOUT_SEC}s")
    await fetch_nsfw_flag(force=True)
    log("[engine] 初始状态：ComfyUI 未启动（等待首个任务冷启动）")

    global _last_activity
    _hb_counter = 0
    _hb_every = max(30, int(POLL_INTERVAL * 5))  # 每 ~10s 打一次心跳（POLL 2s）

    while True:
        try:
            # ---- 心跳上报（供外部自动重启检测；失败不影响主流程） ----
            _hb_counter += 1
            if _hb_counter >= _hb_every / POLL_INTERVAL:
                _hb_counter = 0
                try:
                    await engine_request("POST", f"/api/engine/heartbeat?engine_id={ENGINE_ID}")
                except Exception:
                    pass

            # ---- 空闲检测：任务不来时关闭 ComfyUI（释放 GPU） ----
            now = time.time()
            if not comfyui_is_sleeping() and (now - _last_activity) > IDLE_TIMEOUT_SEC:
                log(f"[engine] 空闲超过 {IDLE_TIMEOUT_SEC}s，关闭 ComfyUI 以释放 GPU")
                await shutdown_comfyui()

            # ---- 取任务 ----
            task = await claim_task()
            if task:
                # 有任务：确保 ComfyUI 已就绪（冷启动自动触发）
                await ensure_comfyui()
                await process_task(task)
                _last_activity = time.time()  # 更新活跃时间
            else:
                await asyncio.sleep(POLL_INTERVAL)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log(f"[engine] 主循环异常: {e}")
            await asyncio.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    asyncio.run(main())

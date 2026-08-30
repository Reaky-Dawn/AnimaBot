import asyncio
import json
import os
import sys
import subprocess
import time
import base64
import httpx
from utils import log

# 在此配置你的 ComfyUI 实例地址
# Kaggle notebook 启动 2 个实例：8188（cuda:0）+ 8189（cuda:1），两端口都纳入候选
COMFY_HOSTS = ["http://127.0.0.1:8188", "http://127.0.0.1:8189"]

# Sprint 10：请求超时下限 600s（原值 5 → 600；run_workflow 的 timeout=3000 已 >600 不动）
REQUEST_TIMEOUT = 600

# ComfyUI 就绪重试（Sprint 11）：ComfyUI 启动需加载模型，可能比引擎 claim 到任务慢。
# pick_idle_host 找不到可用实例时不立即判死刑，而是「探测就绪 → 等待 → 重试」数轮，
# 避免进程刚起的 ComfyUI 被误判为不可达而整个任务 draw_failed。
READY_RETRIES = 12
READY_RETRY_DELAY = 5.0  # 秒；单实例最多等待 60s 就绪

# Sprint 11.5：ComfyUI 生命周期管理（空闲休眠 / 有任务冷启动）
# 引擎自己管理 ComfyUI：空闲时关闭（释放 GPU、零消耗），有新任务时冷启动（加载模型约 30-60s）。
# 实例启动配置与 notebook 单元格 6 一致（CUDA_VISIBLE_DEVICES 指定 GPU，--device 参数无效已移除）。
COMFYUI_INSTANCES = [
    {
        "script": "/kaggle/working/ComfyUI/main.py",
        "cwd": "/kaggle/working/ComfyUI",
        "args": ["--disable-cuda-malloc", "--use-sage-attention", "--disable-dynamic-vram",
                 "--gpu-only", "--port", "8188"],
        "env": {"CUDA_VISIBLE_DEVICES": "0"},
    },
    {
        "script": "/kaggle/working/ComfyUI/main.py",
        "cwd": "/kaggle/working/ComfyUI",
        "args": ["--disable-cuda-malloc", "--use-sage-attention", "--disable-dynamic-vram",
                 "--gpu-only", "--port", "8189"],
        "env": {"CUDA_VISIBLE_DEVICES": "1"},
    },
]

_pick_lock = asyncio.Lock()

# ---- ComfyUI 进程管理状态 ----
_comfyui_procs = []       # 当前运行的 ComfyUI 子进程列表
_comfyui_sleeping = False  # 是否处于休眠（未启动）
_comfyui_start_lock = asyncio.Lock()


async def start_comfyui():
    """冷启动所有 ComfyUI 实例，并等待就绪（最多 120s）。"""
    global _comfyui_procs, _comfyui_sleeping
    async with _comfyui_start_lock:
        if not _comfyui_sleeping and _comfyui_procs:
            return  # 已在运行
        log("[ComfyUI] 冷启动实例…")
        _comfyui_procs = []
        for inst in COMFYUI_INSTANCES:
            proc_env = dict(os.environ)
            proc_env.update(inst["env"])
            out = open(os.devnull, "w")
            err = open(os.devnull, "w")
            try:
                p = subprocess.Popen(
                    [sys.executable, "-u", inst["script"]] + inst["args"],
                    cwd=inst["cwd"], env=proc_env, stdout=out, stderr=err,
                )
                _comfyui_procs.append(p)
                log(f"[ComfyUI] 已启动 {inst['args'][-1]}（PID {p.pid}）")
            except Exception as e:
                log(f"[ComfyUI] 启动失败 {inst['args'][-1]}: {e}")
        _comfyui_sleeping = False
    # 等待就绪（外部循环会探测；这里简单等待若干秒）
    for _ in range(READY_RETRIES * 2):
        if all(await asyncio.gather(*[_host_ready(h) for h in COMFY_HOSTS])):
            log("[ComfyUI] 全部实例就绪")
            return
        await asyncio.sleep(READY_RETRY_DELAY)
    log("[ComfyUI] 就绪等待超时（部分实例可能仍不可用，交给 pick_idle_host 重试）")


async def shutdown_comfyui():
    """空闲休眠：停止所有 ComfyUI 实例（释放 GPU，零消耗）。"""
    global _comfyui_procs, _comfyui_sleeping
    async with _comfyui_start_lock:
        for p in _comfyui_procs:
            try:
                p.terminate()
            except Exception:
                pass
        # 兜底 pkill
        subprocess.run(["pkill", "-f", "ComfyUI/main.py"], capture_output=True)
        _comfyui_procs = []
        _comfyui_sleeping = True
        log("[ComfyUI] 已休眠（所有实例关闭，GPU 释放）")


async def ensure_comfyui():
    """有任务时调用：确保 ComfyUI 在运行（休眠则冷启动）。"""
    if _comfyui_sleeping or not _comfyui_procs:
        await start_comfyui()


def comfyui_is_sleeping() -> bool:
    """查询 ComfyUI 是否处于休眠（外部模块用函数访问，避免 import 绑定失效）。"""
    return _comfyui_sleeping


async def _get_queue_depth(host):
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        resp = await client.get(f"{host}/queue")
        resp.raise_for_status()
        data = resp.json()
        return len(data.get("queue_running", [])) + len(data.get("queue_pending", []))


async def _host_ready(host: str) -> bool:
    """轻量就绪探测：GET /system_stats 可连即可（比 /queue 更早可服务）。"""
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{host}/system_stats")
            resp.raise_for_status()
            return True
    except Exception:
        return False


async def pick_idle_host():
    """选择队列最浅的可用实例。

    Sprint 11 变更：无可用实例时进入「就绪等待」循环（最多 READY_RETRIES 轮，
    每轮间隔 READY_RETRY_DELAY）。ComfyUI 冷启动加载模型需要数十秒，引擎在
    claim 任务后 ComfyUI 可能仍在启动中；等待而非立即抛错可显著降低 draw_failed。
    Sprint 11.5：若实例已休眠（被空闲关闭），先冷启动再等待。
    """
    global _comfyui_sleeping
    for attempt in range(READY_RETRIES):
        candidates = []
        for host in COMFY_HOSTS:
            try:
                depth = await _get_queue_depth(host)
                candidates.append((depth, host))
            except Exception:
                # 不可达 → 静默收集，统一在轮末判断是否继续等待
                continue
        if candidates:
            candidates.sort(key=lambda x: x[0])
            host = candidates[0][1]
            log(f"[ComfyUI] 选择 {host}（队列深度 {candidates[0][0]}）")
            return host
        # 无可用实例：若处于休眠 → 冷启动
        if _comfyui_sleeping:
            log("[ComfyUI] 实例休眠中，触发冷启动…")
            await start_comfyui()
        if attempt < READY_RETRIES - 1:
            log(f"[ComfyUI] 所有实例尚未就绪（第 {attempt + 1}/{READY_RETRIES} 轮），"
                f"{READY_RETRY_DELAY}s 后重试…")
            await asyncio.sleep(READY_RETRY_DELAY)
    raise RuntimeError("所有 ComfyUI 实例均不可达")


def load_workflow(path, overrides: dict | None = None):
    with open(path, encoding="utf-8") as f:
        workflow = json.load(f)
    if overrides:
        for node_id, inputs in overrides.items():
            if node_id in workflow:
                workflow[node_id]["inputs"].update(inputs)
    return workflow


async def post_prompt(workflow, host=None, client_id=None):
    if host is None:
        host = await pick_idle_host()
    body = {"prompt": workflow}
    if client_id:
        body["client_id"] = client_id
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        resp = await client.post(
            f"{host}/prompt",
            json=body,
        )
        resp.raise_for_status()
        return resp.json()


async def get_history(prompt_id, host):
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        resp = await client.get(f"{host}/history/{prompt_id}")
        resp.raise_for_status()
        return resp.json()


async def run_workflow(workflow, wait=True, poll_interval=1.0, timeout=3000):
    async with _pick_lock:
        host = await pick_idle_host()
        result = await post_prompt(workflow, host=host)
    prompt_id = result["prompt_id"]
    log(f"Submitted prompt: {prompt_id} -> {host}")

    if not wait:
        return prompt_id

    start = time.time()
    while True:
        if time.time() - start > timeout:
            raise TimeoutError(f"Prompt {prompt_id} timed out on {host}")
        history_data = await get_history(prompt_id, host)
        if history_data and prompt_id in history_data:
            history = history_data[prompt_id]
            status = history.get("status", {})
            if status.get("completed"):
                results = []
                for node_id, node_output in history.get("outputs", {}).items():
                    if "images_data" in node_output:
                        for img in node_output["images_data"]:
                            results.append(base64.b64decode(img["data"]))
                return results
            elif status.get("status_str") == "error":
                raise RuntimeError(f"Execution error on {host}: {history}")
        await asyncio.sleep(poll_interval)

import asyncio
import json
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

_pick_lock = asyncio.Lock()


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
    """
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

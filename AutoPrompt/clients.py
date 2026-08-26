"""
clients.py —— LLM 客户端（Sprint 10：4 槽位 failover 版）

变更（对比 Sprint 8 版）：
  - 原 cheap/quality 双客户端 → 4 个 provider 槽位 + FailoverClient 代理
  - 4 个槽位共用同一个模型（config.json 顶层 "model"，默认 deepseek-v4-flash）；
    每个槽位只需 api_key + base_url（+可选 timeout）
  - 请求顺序：第 1 个槽位为主，出错按从上到下依次尝试
  - 全部失败抛 AllProvidersFailed（聚合各槽位错误，api_key 已脱敏）
  - 超时下限 600s：timeout = max(槽位配置, 600)（原值 >600s 的不动）
  - 对外暴露接口不变：client_cheap / client_quality 均有 .chat.completions.create(...)
"""

import json
import os

from openai import AsyncOpenAI

# Sprint 10：请求超时下限（秒）。所有槽位 timeout = max(配置值, 600)。
DEFAULT_TIMEOUT = 600


def load_config() -> dict:
    cfg_path = "config.json"
    if not os.path.exists(cfg_path):
        return {}
    with open(cfg_path, encoding="utf-8") as f:
        raw = f.read().strip()
        return json.loads(raw) if raw else {}


cfg = load_config()

# 槽位列表（providers）。兼容旧结构：仅 cheap/quality 单槽位时映射为 1 个槽位。
PROVIDERS = list(cfg.get("providers") or [])
if not PROVIDERS and cfg.get("cheap") and cfg.get("quality"):
    PROVIDERS = [{
        "api_key": cfg["cheap"]["api_key"],
        "base_url": cfg["cheap"]["base_url"],
    }]

# 全局模型（4 槽位共用；缺失时调用方可显式传 model 覆盖）
MODEL = cfg.get("model") or ""


def sanitize(text: str) -> str:
    """错误信息脱敏：把任何槽位的 api_key 替换为 ***（避免日志/网页泄露密钥）。"""
    out = text or ""
    for p in PROVIDERS:
        key = (p.get("api_key") or "").strip()
        if key and key in out:
            out = out.replace(key, "***")
    return out


class AllProvidersFailed(RuntimeError):
    """4 个槽位全部失败时抛出（聚合各槽位错误，已脱敏）。"""

    def __init__(self, errors):
        self.errors = list(errors)
        super().__init__("所有 LLM 槽位均失败: " + " | ".join(self.errors))


class _Completions:
    """伪装 AsyncOpenAI 的 .chat.completions 链，create 时转发给 FailoverClient。"""

    def __init__(self, owner):
        self._owner = owner

    async def create(self, **kwargs):
        return await self._owner._create(kwargs)


class _Chat:
    def __init__(self, owner):
        self._owner = owner
        self.completions = _Completions(owner)


class FailoverClient:
    """按槽位顺序 failover 的 OpenAI 兼容客户端代理。

    - 全部槽位使用同一模型：config.json 顶层 "model"（调用方可显式传 model 覆盖）
    - 暴露 .chat.completions.create(...)，与 AsyncOpenAI 调用点兼容（agent_core 无需大改）
    """

    def __init__(self):
        self.chat = _Chat(self)
        self._clients = {}

    def _client_for(self, idx):
        if idx not in self._clients:
            p = PROVIDERS[idx]
            timeout = max(float(p.get("timeout") or DEFAULT_TIMEOUT), DEFAULT_TIMEOUT)
            self._clients[idx] = AsyncOpenAI(
                api_key=p.get("api_key") or "",
                base_url=p.get("base_url") or "",
                timeout=timeout,
            )
        return self._clients[idx]

    async def _create(self, kwargs):
        errors = []
        if not PROVIDERS:
            raise RuntimeError("config.json 未配置任何 LLM 槽位（providers）")
        model = kwargs.pop("model", None) or MODEL
        for idx, p in enumerate(PROVIDERS):
            try:
                client = self._client_for(idx)
                return await client.chat.completions.create(model=model, **kwargs)
            except Exception as e:  # 该槽位失败 → 记录并尝试下一个
                errors.append(f"槽位{idx + 1} [{p.get('base_url')}]: {sanitize(str(e))}")
        raise AllProvidersFailed(errors)


# 保持两个实例名（agent_core 按角色 import），行为一致：4 槽位按序 failover、同一模型
client_cheap = FailoverClient()
client_quality = FailoverClient()
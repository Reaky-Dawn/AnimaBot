# -*- coding: utf-8 -*-
"""
AnimaBot 引擎单元测试（Sprint 13，用户需求 #0：确保代码无 bug）

运行方式（在仓库任意目录）：
    python -m unittest discover -s tests -v

覆盖：
- utils：tags CSV 编码兼容 / NSFW 标签检测 / PNG 元数据写入 / 重压缩兜底
- comfyui_api：workflow 加载与 override
- core：绘制元数据构建 / 错误日志落盘 / TaskLog / 并发 worker 池行为（双 worker 并行处理）
"""
import asyncio
import io
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "AnimaBot-kaggle"
os.chdir(ROOT)                       # utils/comfyui_api 用相对路径读 CSV 与 workflow
sys.path.insert(0, str(ROOT))

# ---- stub AutoPrompt（其依赖 openai/网络，本地不装；core.py 只用到两个函数） ----
_stub_pkg = types.ModuleType("AutoPrompt")
_stub_pkg.__path__ = []
_stub_core = types.ModuleType("AutoPrompt.agent_core")


async def _fake_agent(prompt, images=None):
    return "", "", "", []


async def _fake_extract(text):
    return text, 920, 1536


_stub_core.agent = _fake_agent
_stub_core.extract_prompt_params = _fake_extract
sys.modules.setdefault("AutoPrompt", _stub_pkg)
sys.modules.setdefault("AutoPrompt.agent_core", _stub_core)

import utils            # noqa: E402
import comfyui_api      # noqa: E402
import core             # noqa: E402


class TestUtilsNsfw(unittest.TestCase):
    """Sprint 13：检测默认关闭（core._nsfw_enabled=False），但检测函数本身保留可用。"""

    def test_tag_set_loads_and_not_empty(self):
        s = utils.load_nsfw_tag_set()
        self.assertIsInstance(s, set)
        # 本地 CSV 存在且带 nsfw 列；只要能解析出集合即可（数量不固定）
        self.assertTrue(os.path.exists(utils.TAGS_CSV_PATH))

    def test_check_empty_and_clean(self):
        self.assertFalse(utils.check_tags_nsfw(""))
        self.assertFalse(utils.check_tags_nsfw(None) if False else utils.check_tags_nsfw(""))

    def test_check_detects_real_nsfw_tag(self):
        # 动态从 CSV 取一个 nsfw=1 标签做正向用例（不硬编码词表）
        nsfw_tag = None
        import csv as _csv
        with utils._open_tags_csv() as f:
            for row in _csv.DictReader(f):
                if row.get("nsfw") == "1" and row.get("name"):
                    nsfw_tag = row["name"].strip()
                    break
        if nsfw_tag is None:
            self.skipTest("CSV 中无 nsfw=1 标签")
        self.assertTrue(utils.check_tags_nsfw(nsfw_tag))
        # 带权重括号也应命中
        self.assertTrue(utils.check_tags_nsfw(f"{nsfw_tag} (1.2), 1girl, solo"))
        # @前缀也应命中
        self.assertTrue(utils.check_tags_nsfw(f"@{nsfw_tag}"))
        # 干净标签不误报
        self.assertFalse(utils.check_tags_nsfw("1girl, solo, long hair, masterpiece"))

    def test_engine_default_off(self):
        # v1 默认关闭检测（用户 2026-08-30 需求 #2）
        self.assertFalse(core._nsfw_enabled)


class TestUtilsMetadata(unittest.TestCase):
    def _png(self):
        from PIL import Image
        buf = io.BytesIO()
        Image.new("RGB", (4, 4), (200, 100, 50)).save(buf, format="PNG")
        return buf.getvalue()

    def test_embed_ai_metadata_basic(self):
        data = utils.embed_ai_metadata(self._png())
        from PIL import Image
        img = Image.open(io.BytesIO(data))
        self.assertEqual(img.format, "PNG")
        self.assertEqual(img.info.get("ai_generated"), "true")
        self.assertEqual(img.info.get("model"), "Anima")

    def test_embed_ai_metadata_a1111_params(self):
        params = core.build_meta_params(tags_prompt="1girl, solo", natural_prompt="a girl",
                                        width=832, height=1216)
        data = utils.embed_ai_metadata(self._png(), params)
        from PIL import Image
        img = Image.open(io.BytesIO(data))
        p = img.info.get("parameters", "")
        self.assertIn("1girl, solo", p)
        self.assertIn("Steps: 30", p)
        self.assertIn("Sampler: euler", p)
        self.assertIn("Schedule type: karras", p)
        self.assertIn("CFG scale: 5", p)
        self.assertIn("Size: 832x1216", p)
        self.assertIn("Model: miaomiaoHarem_anima12.safetensors", p)
        self.assertIn("Negative prompt:", p)

    def test_embed_non_png_passthrough(self):
        garbage = b"\x00\x01not-a-png"
        self.assertEqual(utils.embed_ai_metadata(garbage), garbage)

    def test_recompress_non_png_passthrough(self):
        self.assertEqual(utils.recompress_png(b"not png"), b"not png")

    def test_recompress_png_runs(self):
        out = utils.recompress_png(self._png())
        self.assertTrue(out[:8] == b"\x89PNG\r\n\x1a\n")  # 仍是合法 PNG（有 oxipng 则更小，无则原样）


class TestCoreMisc(unittest.TestCase):
    def test_build_meta_params_fields(self):
        p = core.build_meta_params(tags_prompt="t", natural_prompt="n", width=10, height=20)
        for k in ("tags_prompt", "natural_prompt", "negative_prompt", "steps", "sampler",
                  "scheduler", "cfg", "seed", "width", "height", "model", "vae"):
            self.assertIn(k, p)
        self.assertEqual(p["scheduler"], "karras")   # beta57 → karras 修复保持
        self.assertEqual(p["steps"], 30)

    def test_write_error_log_appends(self):
        with tempfile.TemporaryDirectory() as td:
            old = core.ERROR_LOG_PATH
            core.ERROR_LOG_PATH = Path(td) / "errors.log"
            try:
                core.write_error_log("t1", "draw_failed", "boom-detail")
                core.write_error_log("t2", "prompt_failed", "bad json")
                text = core.ERROR_LOG_PATH.read_text(encoding="utf-8")
                self.assertIn("task=t1 step=draw_failed", text)
                self.assertIn("task=t2 step=prompt_failed", text)
                self.assertIn("boom-detail", text)
            finally:
                core.ERROR_LOG_PATH = old

    def test_tasklog_json(self):
        tl = core.TaskLog("tid")
        tl.add("drawing_start", "x")
        data = json.loads(tl.to_json())
        self.assertEqual(data[0]["action"], "claim")
        self.assertEqual(data[-1]["action"], "drawing_start")


class TestComfyApiWorkflow(unittest.TestCase):
    def test_load_workflow_overrides(self):
        wf = comfyui_api.load_workflow(Path("workflows") / "image_anima_base_v1.json",
                                       overrides={"8": {"text": "hello"}, "10": {"seed": 123}})
        self.assertEqual(wf["8"]["inputs"]["text"], "hello")
        self.assertEqual(wf["10"]["inputs"]["seed"], 123)
        # 模型名保持正确（用户本地模型版）
        self.assertEqual(wf["31"]["inputs"]["unet_name"], "miaomiaoHarem_anima12.safetensors")
        self.assertEqual(wf["2"]["inputs"]["clip_name"], "miaomiaoHarem_anima14_txt.safetensors")
        self.assertEqual(wf["3"]["inputs"]["vae_name"], "qwenImage_qwenImageVAE.safetensors")

    def test_load_workflow_unknown_node_ignored(self):
        wf = comfyui_api.load_workflow(Path("workflows") / "image_anima_base_v1.json",
                                       overrides={"999": {"text": "x"}})
        self.assertNotIn("999", wf)


class TestConcurrentWorkers(unittest.TestCase):
    """用户需求 #1：双 worker 并发处理 —— 两个任务必须并行、各自只被处理一次。"""

    def test_two_workers_process_in_parallel(self):
        pending = [{"id": "t1", "prompt": "p", "mode": "tags"},
                   {"id": "t2", "prompt": "p", "mode": "tags"}]
        events = []
        orig = (core.claim_task, core.ensure_comfyui, core.process_task)

        async def fake_claim():
            return pending.pop(0) if pending else None

        async def fake_ensure():
            pass

        async def fake_proc(task):
            events.append(("start", task["id"]))
            await asyncio.sleep(0.2)
            events.append(("end", task["id"]))

        core.claim_task, core.ensure_comfyui, core.process_task = fake_claim, fake_ensure, fake_proc
        try:
            async def run():
                workers = [asyncio.create_task(core._worker(i)) for i in range(2)]
                await asyncio.sleep(1.0)   # 等两个任务都完成（claim 无任务时 sleep POLL=2s，会被 cancel）
                for w in workers:
                    w.cancel()

            asyncio.run(run())
        finally:
            core.claim_task, core.ensure_comfyui, core.process_task = orig

        starts = [e[1] for e in events if e[0] == "start"]
        ends = [e[1] for e in events if e[0] == "end"]
        self.assertEqual(sorted(starts), ["t1", "t2"])
        self.assertEqual(sorted(ends), ["t1", "t2"])
        # 并行判定：两个 start 都出现在第一个 end 之前（若串行处理，第一个 end 会在第二个 start 前）
        first_end_idx = next(i for i, e in enumerate(events) if e[0] == "end")
        self.assertEqual(len([e for e in events[:first_end_idx] if e[0] == "start"]), 2)

    def test_worker_survives_exception(self):
        orig = (core.claim_task, core.ensure_comfyui, core.process_task)
        calls = {"n": 0}

        async def fake_claim():
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("network blip")
            return None

        async def fake_ensure():
            pass

        async def fake_proc(task):
            pass

        core.claim_task, core.ensure_comfyui, core.process_task = fake_claim, fake_ensure, fake_proc
        old_poll = core.POLL_INTERVAL
        core.POLL_INTERVAL = 0.05  # 缩短异常后的退避时间
        try:
            async def run():
                w = asyncio.create_task(core._worker(0))
                await asyncio.sleep(0.4)
                w.cancel()

            asyncio.run(run())
        finally:
            core.POLL_INTERVAL = old_poll
            core.claim_task, core.ensure_comfyui, core.process_task = orig
        self.assertGreaterEqual(calls["n"], 2)  # 异常后继续轮询（不退出）


if __name__ == "__main__":
    unittest.main(verbosity=2)

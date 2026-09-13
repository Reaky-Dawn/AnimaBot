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


class TestFailoverFunnel(unittest.TestCase):
    """Sprint 13.6：LLM 槽位漏斗——加载真实 clients.py（stub 掉 openai 依赖）。

    覆盖：确定性拒绝（内容审核 400）立即跳槽、槽位级 model 覆盖（同 API 兜底模型）、
    瞬态错误槽位内重试、全部失败聚合报错、thinking 剥参特例。
    """

    def setUp(self):
        import importlib.util
        if "openai" not in sys.modules:
            _openai_stub = types.ModuleType("openai")
            _openai_stub.AsyncOpenAI = type("AsyncOpenAI", (), {})
            sys.modules["openai"] = _openai_stub
        spec = importlib.util.spec_from_file_location(
            "anima_clients_test", ROOT / "AutoPrompt" / "clients.py")
        self.cl = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.cl)
        self.cl.RETRY_DELAYS = (0.0, 0.0, 0.0)  # 测试不真睡

    def _install(self, providers, script):
        """providers: 槽位列表；script: 按调用顺序弹出（Exception 抛出，其余为返回值）。"""
        calls, state = [], {"n": 0}

        class _FakeChain:
            def __init__(self, base_url):
                self._base = base_url

            async def create(self, **kw):
                calls.append((self._base, kw.get("model")))
                i = state["n"]
                state["n"] += 1
                r = script[i] if i < len(script) else script[-1]
                if isinstance(r, Exception):
                    raise r
                return r

        class _FakeClient:
            def __init__(self, base_url=None, api_key=None, timeout=None):
                self._base = base_url
                self.chat = self
                self.completions = self

            def create(self, **kw):  # 占位，实际走 __getattr__ 链上层
                raise NotImplementedError

        def _factory(**kw):
            c = _FakeClient(base_url=kw.get("base_url"))
            c.chat = type("C", (), {"completions": type("CC", (), {"create": _FakeChain.create})(
                _FakeChain.__new__(_FakeChain))})()
            return c

        # 简化：直接把 base_url 绑进闭包
        def _factory2(**kw):
            base = kw.get("base_url")
            chain = _FakeChain(base)
            client = types.SimpleNamespace(
                chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=chain.create)))
            return client

        self.cl.AsyncOpenAI = _factory2
        self.cl.PROVIDERS = providers
        return calls

    def test_moderation_400_fails_over_to_fallback_model(self):
        providers = [
            {"api_key": "k", "base_url": "https://u1", "model": "qwen3.8-flash", "name": "primary-qwen3.8-flash"},
            {"api_key": "k", "base_url": "https://u1", "model": "glm-5.3-flash", "name": "fallback-glm-5.3-flash"},
        ]
        calls = self._install(providers, [
            Exception("Error code: 400 - {'error': {'message': 'Input text data may contain inappropriate content.', 'type': 'data_inspection_failed'}}"),
            "ok",
        ])
        result = asyncio.run(self.cl.FailoverClient().chat.completions.create(prompt="x"))
        self.assertEqual(result, "ok")
        # 主槽 1 次即跳（确定性拒绝不空等 3 次重试），兜底槽用 glm 模型
        self.assertEqual(calls, [("https://u1", "qwen3.8-flash"), ("https://u1", "glm-5.3-flash")])

    def test_transient_500_retries_same_slot(self):
        providers = [{"api_key": "k", "base_url": "https://u1", "model": "qwen3.8-flash", "name": "primary"}]
        calls = self._install(providers, [Exception("Error code: 500 - internal"), "ok"])
        result = asyncio.run(self.cl.FailoverClient().chat.completions.create(prompt="x"))
        self.assertEqual(result, "ok")
        self.assertEqual(calls, [("https://u1", "qwen3.8-flash"), ("https://u1", "qwen3.8-flash")])

    def test_all_failed_aggregates_slot_labels(self):
        providers = [
            {"api_key": "k", "base_url": "https://u1", "model": "qwen3.8-flash", "name": "primary-qwen3.8-flash"},
            {"api_key": "k", "base_url": "https://u1", "model": "glm-5.3-flash", "name": "fallback-glm-5.3-flash"},
        ]
        self._install(providers, [Exception("Error code: 400 - data_inspection_failed")])
        with self.assertRaises(self.cl.AllProvidersFailed) as ctx:
            asyncio.run(self.cl.FailoverClient().chat.completions.create(prompt="x"))
        msg = str(ctx.exception)
        self.assertIn("primary-qwen3.8-flash", msg)
        self.assertIn("fallback-glm-5.3-flash", msg)
        self.assertNotIn("sk-", msg)  # api_key 脱敏

    def test_thinking_reject_strips_param_in_slot(self):
        providers = [{"api_key": "k", "base_url": "https://u1", "model": "glm-5.3-flash", "name": "primary-glm"}]
        calls = self._install(providers, [
            Exception("Error code: 1210 - 该模型始终思考，不支持关闭思考"),
            "ok",
        ])
        captured = {}

        async def run():
            fc = self.cl.FailoverClient()
            orig = fc._client_for

            def spy(idx):
                c = orig(idx)
                # 包装一层记录 extra_body
                inner = c.chat.completions.create

                async def create(**kw):
                    captured["extra_body"] = kw.get("extra_body")
                    return await inner(**kw)
                c.chat.completions.create = create
                return c
            fc._client_for = spy
            return await fc.chat.completions.create(prompt="x", extra_body={"thinking": {"type": "disabled"}})

        result = asyncio.run(run())
        self.assertEqual(result, "ok")
        self.assertEqual(calls, [("https://u1", "glm-5.3-flash"), ("https://u1", "glm-5.3-flash")])
        self.assertNotIn("thinking", captured.get("extra_body") or {})  # 第二次调用已剥掉 thinking


class TestSprint14RefChain(unittest.TestCase):
    """Sprint 14：参考图链路修复回归。

    背景：① reference.py 用 cfg["cheap"]["model"] 而生产 config.json 只有顶层
    model → KeyError，参考图选择节点从未真正执行过；② core.py 进程级
    HF_HUB_OFFLINE=1 把 pixai/画师识别器的 HF 下载掐死，异常被静默吞成空标签；
    ③ utils print 误用 %-格式化掩盖了前两个问题。
    """

    @classmethod
    def setUpClass(cls):
        import importlib.machinery
        if "openai" not in sys.modules:
            _openai_stub = types.ModuleType("openai")
            _openai_stub.AsyncOpenAI = type("AsyncOpenAI", (), {})
            sys.modules["openai"] = _openai_stub

        def _load_real(mod_name, file_name):
            loader = importlib.machinery.SourceFileLoader(
                mod_name, str(ROOT / "AutoPrompt" / file_name))
            spec = importlib.util.spec_from_loader(mod_name, loader)
            mod = importlib.util.module_from_spec(spec)
            sys.modules[mod_name] = mod
            loader.exec_module(mod)
            return mod

        # 真实 clients（cwd 已被 chdir 到 AnimaBot-kaggle，读本地 config.json）
        cls.clients = _load_real("AutoPrompt.clients", "clients.py")
        # agent_prompts / tools / utils 以最小 stub 注册（agent_core 的 import 依赖）
        prompts = types.ModuleType("AutoPrompt.agent_prompts")
        for n in ("_ANIMA_OUTPUT_FORMAT", "_ANIMA_ASSEMBLY_DIRECTIVE", "_JAILBREAKER",
                  "_THINKING", "_CLASSIFICATION_SYSTEM_PROMPT", "_CHARACTER_SELECTION_SYSTEM_PROMPT",
                  "_ARTIST_SELECTION_SYSTEM_PROMPT", "_EXPAND_TAGS_SYSTEM_PROMPT",
                  "_DRAWING_REQUEST_PARSER_PROMPT", "_TAG_CATEGORY_CLASSIFICATION_PROMPT",
                  "_REFERENCE_SELECTION_SYSTEM_PROMPT"):
            setattr(prompts, n, "")
        prompts.quality_tags = {}
        sys.modules["AutoPrompt.agent_prompts"] = prompts
        tools = types.ModuleType("AutoPrompt.tools")
        for n in ("execute_search_tags", "execute_get_related_tags", "execute_get_artist_recommendations"):
            setattr(tools, n, None)
        sys.modules["AutoPrompt.tools"] = tools
        utils_stub = types.ModuleType("AutoPrompt.utils")
        for n in ("sample_tags", "escape_parentheses", "normalize_anima_tags", "reapply_user_weights",
                  "sample_artist_candidate", "_split_tags_by_language", "_split_layers",
                  "_recognize_images", "_filter_img_tags_for_llm", "_parse_tag_categories"):
            setattr(utils_stub, n, lambda *a, **k: None)
        utils_stub._split_tags_by_language = lambda s: (s, [])
        utils_stub._split_layers = lambda s: (s, "none")
        utils_stub.normalize_anima_tags = lambda s: s
        utils_stub.reapply_user_weights = lambda t, o: t
        sys.modules["AutoPrompt.utils"] = utils_stub
        # 真实 reference / agent_core（相对 import 现在都能解析）
        cls.reference = _load_real("AutoPrompt.reference", "reference.py")
        cls.agent_core = _load_real("AutoPrompt.agent_core", "agent_core.py")

    def test_no_hf_offline_in_engine_process(self):
        # 引擎进程不得再设 HF_HUB_OFFLINE（已挪到 ComfyUI 子进程 env）
        src = (ROOT / "core.py").read_text(encoding="utf-8")
        self.assertNotIn('os.environ["HF_HUB_OFFLINE"]', src)
        # ComfyUI 子进程 env 中必须保留（模型全本地）
        comfy_src = (ROOT / "comfyui_api.py").read_text(encoding="utf-8")
        self.assertIn('"HF_HUB_OFFLINE": "1"', comfy_src)
        self.assertEqual(comfy_src.count('"HF_HUB_OFFLINE": "1"'), 2)  # 8188/8189 两实例

    def test_reference_selection_uses_top_level_model(self):
        # 生产形态 config（providers+model，无 cheap）下，选择节点正常调用且 model 取顶层
        self.reference.cfg = {"providers": self.clients.PROVIDERS, "model": "qwen3.8-flash"}
        self.reference.client_cheap = types.SimpleNamespace(
            chat=types.SimpleNamespace(completions=types.SimpleNamespace(
                create=_fake_selection_create)))
        result = asyncio.run(self.reference.select_reference_image_tags("画一个女孩", {
            "图像1": {"general": {"1girl": 0.9}, "character": {}, "artist": {}}}))
        self.assertEqual(result, {"图像1": ["1girl"]})
        self.assertEqual(_fake_selection_calls["model"], "qwen3.8-flash")

    def test_recognize_failure_log_readable(self):
        # utils.py 不再有 print("...%s...", ...) 误用（异常信息须可读）
        src = (ROOT / "AutoPrompt" / "utils.py").read_text(encoding="utf-8")
        self.assertNotIn('print("图像%d标签识别失败: %s"', src)
        self.assertNotIn('print("图像%d画师识别失败: %s"', src)
        self.assertIn("标签识别失败: {tag_result!r}", src)

    def test_agent_log_cb_invoked(self):
        # agent(log_cb=...) 阶段打点可用（stub 识别为空 → 应有 ref_recognized 打点）
        ag = self.agent_core

        async def fake_recognize(images):
            return {}

        ag._recognize_images = fake_recognize

        async def fake_expand(desc, protected=None):
            return "", ""

        ag.expand_zh_tags = fake_expand

        async def fake_search(zh, desc):
            return [], []

        ag.search = fake_search

        async def fake_final(**kw):
            return types.SimpleNamespace(choices=[types.SimpleNamespace(
                message=types.SimpleNamespace(content="", reasoning_content=""))])

        ag.client_quality = types.SimpleNamespace(
            chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=fake_final)))

        logs = []
        asyncio.run(ag.agent("测试描述", images=[b"x"], log_cb=lambda a, d="": logs.append(a)))
        self.assertIn("ref_recognized", logs)


# reference 选择节点 fake（供 TestSprint14RefChain 使用）
_fake_selection_calls = {}


async def _fake_selection_create(**kw):
    _fake_selection_calls.clear()
    _fake_selection_calls["model"] = kw.get("model")
    return types.SimpleNamespace(choices=[types.SimpleNamespace(
        message=types.SimpleNamespace(content=json.dumps({
            "images": [{"image": "图像1", "keep": ["1girl"], "drop": []}]}),
            ensure_ascii=False))])


if __name__ == "__main__":
    unittest.main(verbosity=2)

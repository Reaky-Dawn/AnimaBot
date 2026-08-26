import json
import os
import io
import re
import csv
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, PngImagePlugin

CONFIG_PATH = "config.json"
TAGS_CSV_PATH = Path("AutoPrompt") / "tags_enhanced.csv"

_logging_enabled = None

def _load_logging_flag():
    global _logging_enabled
    if _logging_enabled is not None:
        return _logging_enabled
    try:
        if os.path.exists(CONFIG_PATH):
            with open(CONFIG_PATH, encoding="utf-8") as f:
                _logging_enabled = json.load(f).get("logging", True)
        else:
            _logging_enabled = True
    except:
        _logging_enabled = True
    return _logging_enabled

def log(*args, **kwargs):
    if _load_logging_flag():
        print(*args, **kwargs)

# ===== Sprint 8：tags_prompt NSFW 检测（对象 = 引擎输出标签，非图像分类） =====

_nsfw_tag_set = None

def load_nsfw_tag_set():
    """从 tags_enhanced.csv 加载 nsfw 标签集（Danbooru 标签分级）。"""
    global _nsfw_tag_set
    if _nsfw_tag_set is not None:
        return _nsfw_tag_set
    _nsfw_tag_set = set()
    try:
        with open(TAGS_CSV_PATH, encoding="utf-8") as f:
            for row in csv.DictReader(f):
                if row.get("nsfw", "0") == "1":
                    _nsfw_tag_set.add(row["name"].strip())
    except Exception as e:
        log(f"[NSFW] 加载 tags 表失败（按空集处理，不拦截）: {e}")
    return _nsfw_tag_set

def check_tags_nsfw(tags_prompt: str) -> bool:
    """检测对象 = 引擎输出的提示词标签（非图像分类）。参考图不参与检测。

    注意：此函数受 NSFW_FILTER_ENABLED 控制（Worker /api/health），
    政治敏感拦截由 Worker POST /api/tasks 恒定过滤，不在此处处理。
    """
    if not tags_prompt:
        return False
    tag_set = load_nsfw_tag_set()
    if not tag_set:
        return False
    for raw in tags_prompt.split(","):
        tag = raw.strip().lstrip("@").lower()
        # 去掉权重 (1.2) 与括号转义
        tag = re.sub(r"\(.*?\)", "", tag).strip()
        if tag in tag_set:
            log(f"[NSFW] 命中标签: {tag}")
            return True
    return False

# ===== Sprint 8：oxipng 无损重压缩（NFR-25，分辨率不降） =====

def recompress_png(data: bytes) -> bytes:
    """oxipng 无损重压缩（NFR-25：结果图分辨率不降）。oxipng 不可用时原样返回。"""
    if not data or data[:8] != b"\x89PNG\r\n\x1a\n":
        return data
    try:
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "in.png"
            dst = Path(tmp) / "out.png"
            src.write_bytes(data)
            proc = subprocess.run(
                ["oxipng", "-O", "2", "--strip", "safe", "-i", "0", "-o", str(dst), str(src)],
                capture_output=True, timeout=120,
            )
            if proc.returncode == 0 and dst.exists():
                compressed = dst.read_bytes()
                log(f"[oxipng] 压缩完成: {len(data)} → {len(compressed)} bytes（{100*len(compressed)//len(data) if data else 0}%）")
                return compressed
    except FileNotFoundError:
        log("[oxipng] 未安装 oxipng 二进制，跳过压缩（不影响流程）")
    except Exception as e:
        log(f"[oxipng] 异常: {e}")
    return data

# ===== Sprint 8：AI 生成隐式标识（GB 45438-2025，tech-design 9.1） =====

def embed_ai_metadata(data: bytes) -> bytes:
    """用 Pillow 向 PNG 写入 AI 元数据（tEXt chunk）；JPEG 暂不支持（引擎输出为 PNG，NFR-25）。"""
    try:
        img = Image.open(io.BytesIO(data))
        if img.format == "PNG":
            pnginfo = PngImagePlugin.PngInfo()
            pnginfo.add_text("ai_generated", "true")
            pnginfo.add_text("model", "Anima")
            pnginfo.add_text("generator", "AnimaBot-web")
            pnginfo.add_text("timestamp", datetime.now(timezone.utc).isoformat(timespec="seconds"))
            buf = io.BytesIO()
            img.save(buf, format="PNG", pnginfo=pnginfo, optimize=False)
            return buf.getvalue()
        return data
    except Exception as e:
        log(f"[metadata] 写入失败: {e}")
        return data
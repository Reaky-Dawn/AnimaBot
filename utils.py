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


def _open_tags_csv():
    """以兼容方式打开 tags_enhanced.csv。

    该文件的中文列（cn_name/wiki）为 GBK/GB18030 编码，直接 utf-8 读取会抛
    UnicodeDecodeError（'utf-8' codec can't decode byte ...）。由于 open()
    的 encoding 参数是惰性解码的（读取时才抛异常），不能靠 try-open 判定编码。
    正确做法：先读头 N 字节，尝试 utf-8 解码，失败则回退 gb18030。
    """
    from pathlib import Path
    raw = Path(TAGS_CSV_PATH).read_bytes()
    for enc in ("utf-8", "gb18030"):
        try:
            raw.decode(enc)
            return open(TAGS_CSV_PATH, encoding=enc)
        except (UnicodeDecodeError, UnicodeError):
            continue
    return open(TAGS_CSV_PATH, encoding="gb18030")  # 兜底

def load_nsfw_tag_set():
    """从 tags_enhanced.csv 加载 nsfw 标签集（Danbooru 标签分级）。"""
    global _nsfw_tag_set
    if _nsfw_tag_set is not None:
        return _nsfw_tag_set
    _nsfw_tag_set = set()
    try:
        with _open_tags_csv() as f:
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

def embed_ai_metadata(data: bytes, params: dict | None = None) -> bytes:
    """用 Pillow 向 PNG 写入 AI 元数据（tEXt/iTXt chunk）；JPEG 暂不支持（引擎输出为 PNG，NFR-25）。

    params（可选）会生成 A1111 风格的 `parameters` 文本块，包含项目实际使用的绘制参数：
    tags_prompt, natural_prompt, negative_prompt, steps, sampler, cfgs, seed, width, height, model, vae。

    不存在的字段（如 Hires upscale、Lora hashes）不会添加。
    """
    try:
        img = Image.open(io.BytesIO(data))
        if img.format == "PNG":
            pnginfo = PngImagePlugin.PngInfo()
            pnginfo.add_text("ai_generated", "true")
            pnginfo.add_text("model", "Anima")
            pnginfo.add_text("generator", "AnimaBot-web")
            pnginfo.add_text("timestamp", datetime.now(timezone.utc).isoformat(timespec="seconds"))

            # Sprint 11: A1111 风格 parameters 文本块（只含项目实际使用的字段）
            if params:
                parts = []
                # 正面提示词：tags + natural 合并
                if params.get("tags_prompt") or params.get("natural_prompt"):
                    pos = ", ".join(filter(None, [params.get("tags_prompt", ""), params.get("natural_prompt", "")]))
                    parts.append(pos)
                # 负面提示词
                if params.get("negative_prompt"):
                    parts.append("Negative prompt: " + params["negative_prompt"])
                # 参数行
                param_items = []
                if params.get("steps"):
                    param_items.append("Steps: " + str(params["steps"]))
                if params.get("sampler"):
                    param_items.append("Sampler: " + params["sampler"])
                if params.get("scheduler"):
                    param_items.append("Schedule type: " + params["scheduler"])
                if params.get("cfg"):
                    param_items.append("CFG scale: " + str(params["cfg"]))
                if params.get("seed"):
                    param_items.append("Seed: " + str(params["seed"]))
                if params.get("width") and params.get("height"):
                    param_items.append("Size: " + str(params["width"]) + "x" + str(params["height"]))
                if params.get("model"):
                    param_items.append("Model: " + params["model"])
                if params.get("vae"):
                    param_items.append("VAE: " + params["vae"])
                if params.get("denoise"):
                    param_items.append("Denoising strength: " + str(params["denoise"]))
                if param_items:
                    parts.append(", ".join(param_items))
                # 用 iTXt 块写入 parameters（A1111 标准块名，iTXt 支持 Unicode）
                parameters_str = "\n".join(parts)
                if parameters_str:
                    pnginfo.add_text("parameters", parameters_str)
                    log(f"[metadata] 已写入 parameters 元数据（{len(parameters_str)} 字符）")

            buf = io.BytesIO()
            img.save(buf, format="PNG", pnginfo=pnginfo, optimize=False)
            return buf.getvalue()
        return data
    except Exception as e:
        log(f"[metadata] 写入失败: {e}")
        return data
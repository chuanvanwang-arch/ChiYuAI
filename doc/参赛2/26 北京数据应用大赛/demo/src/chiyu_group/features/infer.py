"""推理后端统一抽象：bge 稠密(可插拔) → 哈希签名(确定性兜底) → 关键词稀疏。
INFER_BACKEND: auto|cpu|cuda|ascend|none
- auto: 探测 torch_npu → torch.cuda → onnxruntime CPU → none
- none: 无模型，一律哈希降级（零 GPU 可跑）
"""
import hashlib
import numpy as np
import os

DEFAULT_DIM = 384
HASH_DIM = 384


def hash_signature(text: str, dim: int = HASH_DIM) -> np.ndarray:
    """确定性哈希签名向量（可复现，无随机性）。"""
    v = np.zeros(dim, dtype=np.float32)
    tokens = _tokenize(text)
    for i, tok in enumerate(tokens):
        h = int(hashlib.md5(tok.encode("utf-8")).hexdigest(), 16)
        idx = h % dim
        sign = 1.0 if (h >> 8) % 2 == 0 else -1.0
        v[idx] += sign
    n = np.linalg.norm(v)
    return v / n if n > 0 else v


def _tokenize(text: str) -> list:
    # 简中切分：单字 + 英文单词
    toks = []
    for w in __import__("re").findall(r"[A-Za-z0-9_]+|[\u4e00-\u9fa5]", text):
        toks.append(w)
    # 中文二元组补充
    cjk = [c for c in text if "\u4e00" <= c <= "\u9fa5"]
    toks += [cjk[i] + cjk[i + 1] for i in range(len(cjk) - 1)]
    return toks


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


class InferBackend:
    """统一推理后端。encode(text) -> ndarray。
    text 须为清洗后文本（≤480 字符）。"""

    def __init__(self, backend: str = "auto", model_dir: str | None = None):
        self.backend = self._resolve(backend)
        self.model_dir = model_dir
        self._session = None
        self._dim = HASH_DIM
        if self.backend in ("cpu", "cuda", "ascend"):
            self._load_model()

    @staticmethod
    def _resolve(b: str) -> str:
        b = (b or os.environ.get("INFER_BACKEND", "auto")).lower()
        if b != "auto":
            return b
        try:
            import torch_npu  # noqa: F401
            return "ascend"
        except ImportError:
            pass
        try:
            import torch  # noqa: F401
            if torch.cuda.is_available():
                return "cuda"
        except ImportError:
            pass
        try:
            import onnxruntime  # noqa: F401
            return "cpu"
        except ImportError:
            pass
        return "none"

    def _load_model(self):
        """加载 bge-large-zh-v1.5 ONNX。失败→none（fail-open）。"""
        try:
            import onnxruntime as ort
            p = os.path.join(self.model_dir or "", "bge-large-zh-v1.5.onnx")
            self._session = ort.InferenceSession(p, providers=["CPUExecutionProvider"])
            self._dim = 1024
        except Exception:
            self._session = None
            self.backend = "none"
            self._dim = HASH_DIM

    def encode(self, text: str) -> np.ndarray:
        if self._session is not None:
            try:
                # 简化：ONNX 输入 [1,seq] token ids；此处以哈希占位并留接口
                # 完整实现见 features/onnx_runner.py（M2.5 接线）
                return hash_signature(text, HASH_DIM)
            except Exception:
                pass
        return hash_signature(text, HASH_DIM)

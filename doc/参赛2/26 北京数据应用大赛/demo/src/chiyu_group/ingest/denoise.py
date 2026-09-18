"""模板噪声过滤：固定前缀/尾部套话/多余空白。"""
import re

_PREFIX_PATS = [
    re.compile(r"工单来源[：:].*?(?=\n|$)", re.S),
    re.compile(r"此工单内容为网民留言时填写的标题及原文", re.S),
    re.compile(r"^=+\s*", re.M),
]
_DUP_TAIL = re.compile(r"((?:请尽快处理|请核实处理)[。！?]?)+(?=$)")
_MULTI_SP = re.compile(r"[ \t]+")
_MULTI_NL = re.compile(r"\n{2,}")


def denoise(text: str) -> str:
    t = text
    for p in _PREFIX_PATS:
        t = p.sub("", t)
    t = _DUP_TAIL.sub(r"\1", t)
    # 去掉尾部连续套话后再修剪
    t = re.sub(r"(?:请尽快处理[。！?]?)+$", "", t)
    t = re.sub(r"(?:请核实处理[。！?]?)+$", "", t)
    t = _MULTI_SP.sub(" ", t)
    t = _MULTI_NL.sub("\n", t)
    return t.strip()

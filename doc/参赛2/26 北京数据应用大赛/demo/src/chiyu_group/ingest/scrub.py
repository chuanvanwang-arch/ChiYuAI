"""凭证硬拒：手机号/身份证/银行卡/邮箱在进入记忆与向量通道前剔除。"""
import re

_PHONE = re.compile(r"1[3-9]\d{9}")
_IDCARD = re.compile(r"\d{17}[\dXx]")
_BANK = re.compile(r"\d{16,19}")
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(\.[\w-]+)+")
# 姓名无法用正则可靠识别；对"市民反映/市民:XXX"类口语做保守替换
_NAME_PAT = re.compile(r"(市民|反映人)[:：]?\s*([\u4e00-\u9fa5]{2,4})(?=[，。；\s]|$)")

_PATTERNS = [_PHONE, _IDCARD, _BANK, _EMAIL]


def scrub_credentials(text: str) -> tuple[str, bool]:
    """返回 (脱敏后文本, 是否命中凭证)。命中即留痕（hit=True）。"""
    hit = False
    for pat in _PATTERNS:
        if pat.search(text):
            hit = True
            text = pat.sub("[凭证已剔除]", text)
    text, n = _NAME_PAT.subn(r"\1[姓名已剔除]", text)
    hit = hit or n > 0
    return text, hit

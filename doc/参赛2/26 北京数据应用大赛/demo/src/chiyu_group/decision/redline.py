"""红线规则集：命中任意一条 → 强制人工在环，无论置信度。"""

# 互斥一级类别（跨一级即视为互斥事项，防"同表述异因"）
MUTEX_TOP = {
    "城乡建设", "市场管理", "住房", "社会培训机构", "卫生健康",
    "劳动和社会保障", "交通管理", "公共服务", "市政",
}
# 敏感类别（强制人工）
SENSITIVE = {"卫生健康", "劳动和社会保障"}


def check_redline(admin_a: str, admin_b: str, question_a: str, question_b: str,
                  entity_conflict: bool = False) -> tuple[bool, str]:
    """返回 (是否命中红线, 原因)。红线判定先于置信度。"""
    if admin_a and admin_b and admin_a != admin_b:
        return True, "跨行政区划"
    top_a = question_a.split(">")[0] if question_a else ""
    top_b = question_b.split(">")[0] if question_b else ""
    if top_a and top_b and top_a in MUTEX_TOP and top_b in MUTEX_TOP and top_a != top_b:
        return True, "互斥事项类别"
    if entity_conflict:
        return True, "已确认责任主体冲突"
    if top_a in SENSITIVE or top_b in SENSITIVE:
        return True, "敏感类别"
    return False, ""

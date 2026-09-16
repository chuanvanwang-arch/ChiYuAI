# -*- coding: utf-8 -*-
"""生成 8 段旁白 MP3，并输出每段真实时长供时间轴对齐。"""
import os, re, json, asyncio, subprocess, edge_tts

BASE = os.path.dirname(os.path.abspath(__file__))
FF = r"C:\Users\wangchuan08\.workbuddy\binaries\python\envs\default\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe"
VOICE = "zh-CN-YunyangNeural"
RATE = "-4%"   # 略慢，科技叙事更稳

NARRATIONS = [
    ("s1", "北京青羽智行科技，带来 AI 原生设备管理平台。连接、时序、看板，工业互联网平台已经做得很好；但告警之后谁来判断源头、该怎么处置，仍是空白。我们补的，就是这一段。"),
    ("s2", "看一个真实场景：几十台设备同时告警，屏幕上每一条都在闪。运维缺的从来不是更多的告警，而是哪一条才是真正的源头。"),
    ("s3", "L0 边缘层，每台设备一个边缘智能体。阈值加判据本地研判，瞬时波动与噪声留在本地闭环，只把确认的异常和跨设备疑点上报集群层。"),
    ("s4", "L1 集群层，按时序与工艺耦合做关联归因，区分原发故障与次生告警。六条告警收敛为一条根因：二号给水泵轴承磨损。三号、四号锅炉高温属次生连锁，不建议优先处置。"),
    ("s5", "D 决策层，每条结论都是一条九列决策记录，场景、结论、置信度、依据、风险、概念引用一应俱全，再由九尺子逐项打分。缺什么就报什么，不放行，也不静默通过。"),
    ("s6", "L2 业务层，根因直接变成工单、备件预留与停机排程。处置建议必须带依据与风险，经决策第零闸校验后转人工复核——我们不自动执行任何生产操作。"),
    ("s7", "处置结束，才是知识产生的开始。复盘智能体自动归因，把教训转成标准处置卡，审批后回灌设备记忆与故障知识库。下次同类告警，直接调出先例。"),
    ("s8", "让每一次告警有归因，每一次处置有依据，每一次故障都沉淀成组织的资产。北京青羽智行科技，ChiYu AI。"),
]

# 每幕画面时长 = 旁白时长 + 尾部留白（毫秒）
TAIL = {"s1": 900, "s2": 1200, "s3": 1200, "s4": 1600, "s5": 1400, "s6": 1400, "s7": 1400, "s8": 2600}
LEAD = 600  # 每幕开头静音，给画面先起来


def audio_dur(path):
    out = subprocess.run([FF, "-i", path], capture_output=True, text=True, errors="ignore").stderr
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", out)
    if not m:
        return 5.0
    h, mn, s = map(float, m.groups())
    return h * 3600 + mn * 60 + s


async def gen(sid, text):
    out = os.path.join(BASE, sid + ".mp3")
    comm = edge_tts.Communicate(text, VOICE, rate=RATE)
    await comm.save(out)
    return out


async def main():
    durs = {}
    for sid, text in NARRATIONS:
        p = await gen(sid, text)
        d = audio_dur(p)
        durs[sid] = d
        print("OK %s  %.2fs  %d bytes" % (sid, d, os.path.getsize(p)), flush=True)
    total_audio = sum(durs.values())
    scene_ms = [int(round((durs[sid] * 1000) + LEAD + TAIL[sid])) for sid, _ in NARRATIONS]
    meta = {
        "voice": VOICE,
        "audio_sec": {k: round(v, 2) for k, v in durs.items()},
        "scene_ms": scene_ms,
        "total_ms": sum(scene_ms),
        "total_sec": round(sum(scene_ms) / 1000.0, 1),
    }
    with open(os.path.join(BASE, "durations.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print("\n旁白总时长 %.1fs ｜ 成片总时长 %.1fs" % (total_audio, meta["total_sec"]))
    print("scene_ms =", scene_ms)
    print("->", os.path.join(BASE, "durations.json"))


if __name__ == "__main__":
    asyncio.run(main())

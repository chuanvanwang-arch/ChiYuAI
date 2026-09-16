# -*- coding: utf-8 -*-
"""生成 8 段旁白 MP3，并输出每段真实时长供时间轴对齐。"""
import os, re, json, asyncio, subprocess, edge_tts

BASE = os.path.dirname(os.path.abspath(__file__))
FF = r"C:\Users\wangchuan08\.workbuddy\binaries\python\envs\default\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe"
VOICE = "zh-CN-YunyangNeural"
RATE = "-4%"   # 略慢，科技叙事更稳

NARRATIONS = [
    ("s1", "北京青羽智行科技，带来多智能体可信研判与证据链溯源系统。研判类系统已经能把结论出得很快，但结论凭什么成立，仍然是黑箱。我们补的，就是这一段。"),
    ("s2", "看一个真实处境：多个智能体各执一词，一个说存在协同发布，一个说时间线不成立。简单加权投票之后，分歧被平均数抹平——而恰恰是那条分歧，最有价值。"),
    ("s3", "第一步，先把结论、证据、来源三级结构入图。每条证据支持谁、反驳谁，来源是原始段落还是转述，来源等级如何，全部入库可查。"),
    ("s4", "第二步，三维可信度量。信源可信度、证据强度、逻辑一致性三个维度分别评分。置信度不是一个拍出来的百分比，而是三个可复算的维度结果，结论冲突也在这里被自动识别。"),
    ("s5", "第三步，冲突不靠投票。正方与反方各自陈述依据，仲裁智能体按信源等级与证据强度裁决。裁决把命题降级为待验证，反方意见与理由一并留档，不被覆盖。"),
    ("s6", "第四步，溯源与因果校验。从结论一路下钻到原始段落，命中片段高亮定位；再过因果三关——时序优先、反事实检验、混杂因素排查。三关不过，结论不升格。"),
    ("s7", "最后是全程可审。每一个中间结论都留痕，推理树有已确证、待验证、存疑、缺依据四种状态。复核人可以排除某条证据，系统随即重算，两版结果都写入审计哈希链。"),
    ("s8", "让每一条结论都带着它的证据，让每一次判断都可以被复核，让组织的研判能力可以积累。北京青羽智行科技，ChiYu AI。"),
]

# 每幕画面时长 = 旁白时长 + 尾部留白（毫秒）
TAIL = {"s1": 900, "s2": 1300, "s3": 1200, "s4": 1400, "s5": 1700, "s6": 1500, "s7": 1600, "s8": 2600}
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

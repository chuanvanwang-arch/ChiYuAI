# -*- coding: utf-8 -*-
"""合成成片：帧序列 + 分段旁白（按场景时间轴 padding 对齐）-> H.264 MP4。"""
import os, re, json, subprocess

BASE = os.path.dirname(os.path.abspath(__file__))
FF = r"C:\Users\wangchuan08\.workbuddy\binaries\python\envs\default\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe"
OUT = os.path.join(BASE, "北京青羽智行科技有限公司-AI原生设备管理平台-演示视频-v1.mp4")
FPS = 24
LEAD = 600  # 每段开头静音 ms，与 01_tts.py 一致

with open(os.path.join(BASE, "durations.json"), encoding="utf-8") as f:
    META = json.load(f)
SCENE_MS = META["scene_ms"]
SIDES = ["s%d" % (i + 1) for i in range(8)]


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True, errors="ignore")
    if r.returncode != 0:
        raise RuntimeError(r.stderr[-1500:])


def pad_wav(sid, scene_ms, idx):
    """旁白 mp3 -> 定长 wav（前 LEAD 静音，尾部补齐到场景时长）。"""
    src = os.path.join(BASE, sid + ".mp3")
    dst = os.path.join(BASE, "w%d.wav" % idx)
    sec = scene_ms / 1000.0
    run([FF, "-y", "-i", src, "-af", "adelay=%d|%d,apad" % (LEAD, LEAD),
         "-t", "%.3f" % sec, "-ar", "44100", "-ac", "1", "-c:a", "pcm_s16le", dst])
    return dst


def main():
    wavs = []
    for i, sid in enumerate(SIDES):
        wavs.append(pad_wav(sid, SCENE_MS[i], i))
        print("padded", sid, "-> w%d.wav (%.2fs)" % (i, SCENE_MS[i] / 1000.0), flush=True)

    lst = os.path.join(BASE, "concat_wav.txt")
    with open(lst, "w", encoding="utf-8") as f:
        for w in wavs:
            f.write("file '%s'\n" % w.replace("\\", "/"))
    full = os.path.join(BASE, "full.wav")
    run([FF, "-y", "-f", "concat", "-safe", "0", "-i", lst, "-c:a", "pcm_s16le", full])

    n_frames = len([f for f in os.listdir(os.path.join(BASE, "frames")) if f.startswith("f") and f.endswith(".png")])
    expect = int(round(sum(SCENE_MS) / 1000.0 * FPS))
    print("frames on disk = %d, expect = %d" % (n_frames, expect), flush=True)
    assert n_frames >= expect - 2, "帧数不足，先完成录制"

    print("encoding...", flush=True)
    run([FF, "-y", "-framerate", str(FPS), "-i", os.path.join(BASE, "frames", "f%05d.png"),
         "-i", full,
         "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "1",
         "-movflags", "+faststart", "-shortest", OUT])

    out = subprocess.run([FF, "-i", OUT], capture_output=True, text=True, errors="ignore").stderr
    dur = re.search(r"Duration:\s*([0-9:.]+)", out)
    size = os.path.getsize(OUT)
    print("DONE %s  duration=%s  size=%.1fMB" % (OUT, dur.group(1) if dur else "?", size / 1048576.0), flush=True)


if __name__ == "__main__":
    main()

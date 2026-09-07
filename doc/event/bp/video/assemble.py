# -*- coding: utf-8 -*-
"""幻灯片视频合成：pyttsx3 旁白 + imageio-ffmpeg 拼接"""
import os, wave, subprocess, shutil
import pyttsx3
import imageio_ffmpeg

BASE = r"D:\system\CRM-ai-native\doc\event\bp\video"
FF = imageio_ffmpeg.get_ffmpeg_exe()

NARRATIONS = [
    ("s1", "北京青羽智行科技，带来 AI 原生智能销售管理平台 CRM-AI-Native。传统 CRM 只记录数据，不参与决策；我们让每一次销售决策，可溯、可信、可复制。"),
    ("s2", "B2B 销售普遍面临四大痛点：客户信息分散，商机推进无标准，超权限报价失控，以及 AI 建议不可溯源、不敢使用。大模型与智能体技术的成熟，让企业软件从流程记录走向认知决策，这正是项目的时代机遇。"),
    ("s3", "CRM-AI-Native 是基于多租户 SaaS 的 AI 原生销售管理平台，以智能体为业务内核，覆盖客户全生命周期：从获客、商机推进、报价审批，到合同回款与经营看板，全流程由智能体辅助并保持决策可溯。"),
    ("s4", "平台采用四层架构：用户接入层提供统一门户；智能体层以销售智能体为内核，支持多智能体编排与 MCP 标准化工具接入；AI 决策层采用 K M D 三层管道，知识、记忆、决策逐层递进；数据层基于 PostgreSQL 向量检索，多租户数据严格隔离。"),
    ("s5", "产品覆盖八大功能模块：客户三百六十度视图、商机 S1 到 S6 标准推进、AI 决策引擎、报价审批治理、智能体平台与知识记忆、合同计费与经营看板，形成完整业务闭环。"),
    ("s6", "这是平台最具差异化的场景：当报价折扣超出销售权限，系统强制拦截并触发审批流；审批通过后写入决策标识，全程留痕、可审计。线下私自报价、口头承诺预算造成的治理缺口，在这里被系统性堵住。"),
    ("s7", "所有 AI 建议均附带溯源引用，可下钻到历史决策与知识条目。K M D 决策管道保证输出可解释、可复核；写时向量化记忆系统让平台跨会话记住每一次客户互动，成为企业自有的数据资产。"),
    ("s8", "商业模式方面，平台有四类收入：SaaS 订阅、AI 用量计费、私有化部署与行业增值服务。席位、Token 配额、功能权益三道闸门构成收入硬约束。预计三年营收从三百万增长到两千二百万，毛利率提升至百分之七十八。"),
    ("s9", "市场定位上，传统厂商赢在存量客户、输在架构包袱；通用大模型赢在模型能力、输在场景纵深。本项目在 AI 原生、治理闭环、行业配置化的交叉地带建立差异化壁垒，面向制造、医疗器械、化工、能源等 B2B 复杂销售行业。"),
    ("s10", "本轮拟融资八百万元人民币，出让百分之十到十五的股份，资金用于研发投入、市场拓展与算力资源。产品已真实落地，具备完整知识产权。北京青羽智行科技，让每一次销售决策，可溯、可信、可复制。"),
]

def wav_duration(path):
    with wave.open(path, 'rb') as w:
        return w.getnframes() / float(w.getframerate())

def tts_one(text, wav):
    engine = pyttsx3.init()  # 每页独立 engine，规避 SAPI 复用挂起
    engine.setProperty('voice', r'HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Speech\Voices\Tokens\TTS_MS_ZH-CN_HUIHUI_11.0')
    engine.setProperty('rate', 185)
    engine.save_to_file(text, wav)
    engine.runAndWait()
    engine.stop()

def main():
    # 1) TTS per slide
    durs = []
    for sid, text in NARRATIONS:
        wav = os.path.join(BASE, sid + '.wav')
        if os.path.exists(wav):
            os.remove(wav)
        tts_one(text, wav)
        d = wav_duration(wav)
        durs.append((sid, d))
        print(sid, 'narration %.1fs' % d, flush=True)

    # 2) per-slide segment: image + narration (+lead/tail padding)
    seg_files = []
    for i, (sid, d) in enumerate(durs):
        seg = os.path.join(BASE, 'seg%02d.mp4' % i)
        dur = d + 1.2  # 0.6s lead + 0.6s tail
        cmd = [FF, '-y',
               '-loop', '1', '-i', os.path.join(BASE, sid + '.png'),
               '-i', os.path.join(BASE, sid + '.wav'),
               '-af', 'adelay=600|600,apad',
               '-t', '%.2f' % dur,
               '-c:v', 'libx264', '-r', '24', '-pix_fmt', 'yuv420p',
               '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '1',
               '-shortest', seg]
        subprocess.run(cmd, check=True, capture_output=True)
        seg_files.append(seg)
        print('segment', i, 'ok')

    # 3) concat
    concat_list = os.path.join(BASE, 'concat.txt')
    with open(concat_list, 'w', encoding='utf-8') as f:
        for s in seg_files:
            f.write("file '%s'\n" % s.replace('\\', '/'))
    out = os.path.join(BASE, '北京青羽智行科技有限公司-CRM-AI-Native-演示视频.mp4')
    subprocess.run([FF, '-y', '-f', 'concat', '-safe', '0', '-i', concat_list,
                    '-c', 'copy', '-movflags', '+faststart', out], check=True, capture_output=True)
    total = sum(d for _, d in durs) + 1.2 * len(durs)
    print('DONE %.1fs (%.1f min) -> %s' % (total, total/60, out))

if __name__ == '__main__':
    main()

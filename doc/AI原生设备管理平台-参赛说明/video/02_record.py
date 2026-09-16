# -*- coding: utf-8 -*-
"""Playwright 确定性逐帧录制：seek 到指定时刻 -> 截图。"""
import os, sys, json, time, asyncio
from playwright.async_api import async_playwright

BASE = os.path.dirname(os.path.abspath(__file__))
FRAMES = os.path.join(BASE, "frames")
HTML = os.path.join(BASE, "equipment-video-rec.html").replace("\\", "/")
FPS = 24

with open(os.path.join(BASE, "durations.json"), encoding="utf-8") as f:
    META = json.load(f)
SCENE_MS = META["scene_ms"]
TOTAL_MS = META["total_ms"]
N_FRAMES = int(round(TOTAL_MS / 1000.0 * FPS))
SMOKE = "--smoke" in sys.argv


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=["--force-device-scale-factor=1", "--font-render-hinting=none"])
        ctx = await browser.new_context(
            viewport={"width": 1280, "height": 720},
            device_scale_factor=1.5,
        )
        await ctx.add_init_script("window.__DUR = %s;" % json.dumps(SCENE_MS))
        page = await ctx.new_page()
        await page.goto("file:///" + HTML)
        await page.wait_for_function("window.__seek && window.__total > 0")
        total = await page.evaluate("window.__total")
        print("timeline total = %d ms, frames = %d" % (total, N_FRAMES), flush=True)

        # 冒烟：只截若干关键时刻，供人工检查视觉
        if SMOKE:
            for ms in [500, 19000, 33000, 50000, 71000, 89000, 106000, 123000]:
                await page.evaluate("window.__seek(%d)" % min(ms, total))
                await page.screenshot(path=os.path.join(FRAMES, "smoke_%06d.png" % ms))
            await browser.close()
            print("SMOKE OK ->", FRAMES)
            return

        # 预热
        await page.evaluate("window.__seek(0)")
        await page.screenshot(path=os.path.join(FRAMES, "_warm.png"))

        t0 = time.time()
        for i in range(N_FRAMES):
            t = min(total, i * 1000.0 / FPS)
            await page.evaluate("window.__seek(%.3f)" % t)
            await page.screenshot(path=os.path.join(FRAMES, "f%05d.png" % (i + 1)))
            if (i + 1) % 100 == 0:
                el = time.time() - t0
                eta = el / (i + 1) * (N_FRAMES - i - 1)
                print("  %d/%d  %.1fs elapsed, eta %.1fs" % (i + 1, N_FRAMES, el, eta), flush=True)
        await browser.close()
    print("frames done: %d, cost %.1fs" % (N_FRAMES, time.time() - t0))


if __name__ == "__main__":
    asyncio.run(main())

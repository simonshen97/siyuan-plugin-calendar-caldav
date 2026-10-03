"""生成插件图标与预览图（仅开发期使用，不属于插件运行时产物）。"""
from __future__ import annotations

import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

ACCENT = (53, 116, 240, 255)
ACCENT_DARK = (32, 78, 176, 255)
PAPER = (255, 255, 255, 255)
GRID = (206, 216, 232, 255)
SYNC = (24, 168, 120, 255)
OUTLINE = (23, 34, 54, 255)


def load_font(size: int):
    candidates = [
        r"C:\Windows\Fonts\msyh.ttc",
        r"C:\Windows\Fonts\msyhbd.ttc",
        r"C:\Windows\Fonts\segoeui.ttf",
        r"C:\Windows\Fonts\arial.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def rounded_card(size: int) -> Image.Image:
    scale = 4
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    radius = int(s * 0.19)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=PAPER, outline=(228, 234, 244, 255), width=scale * 2)
    # 顶部标题栏
    d.rounded_rectangle([0, 0, s - 1, int(s * 0.28)], radius=radius, fill=ACCENT)
    d.rectangle([0, int(s * 0.20), s - 1, int(s * 0.28)], fill=ACCENT)
    # 挂钩
    for cx in (int(s * 0.30), int(s * 0.70)):
        d.rounded_rectangle(
            [cx - scale * 5, -scale * 3, cx + scale * 5, int(s * 0.10)],
            radius=scale * 5,
            fill=ACCENT_DARK,
        )
    # 日期网格
    left, top = int(s * 0.14), int(s * 0.36)
    right, bottom = int(s * 0.86), int(s * 0.86)
    cols, rows = 4, 4
    cell_w = (right - left) / cols
    cell_h = (bottom - top) / rows
    for r in range(rows):
        for c in range(cols):
            x0 = left + c * cell_w + scale * 2
            y0 = top + r * cell_h + scale * 2
            x1 = left + (c + 1) * cell_w - scale * 2
            y1 = top + (r + 1) * cell_h - scale * 2
            fill = GRID
            if (r, c) in {(1, 1), (2, 3)}:
                fill = ACCENT
            elif (r, c) == (2, 1):
                fill = SYNC
            d.rounded_rectangle([x0, y0, x1, y1], radius=scale * 3, fill=fill)
    # 同步箭头（右下角）
    d.ellipse(
        [int(s * 0.60), int(s * 0.60), int(s * 0.98), int(s * 0.98)],
        fill=SYNC,
        outline=PAPER,
        width=scale * 3,
    )
    d.arc(
        [int(s * 0.655), int(s * 0.655), int(s * 0.925), int(s * 0.925)],
        start=200,
        end=20,
        fill=PAPER,
        width=scale * 4,
    )
    d.arc(
        [int(s * 0.655), int(s * 0.655), int(s * 0.925), int(s * 0.925)],
        start=20,
        end=200,
        fill=PAPER,
        width=scale * 4,
    )
    arrow = [
        (int(s * 0.63), int(s * 0.70)),
        (int(s * 0.72), int(s * 0.70)),
        (int(s * 0.675), int(s * 0.79)),
    ]
    d.polygon(arrow, fill=PAPER)
    arrow2 = [
        (int(s * 0.95), int(s * 0.88)),
        (int(s * 0.86), int(s * 0.88)),
        (int(s * 0.905), int(s * 0.79)),
    ]
    d.polygon(arrow2, fill=PAPER)
    return img.resize((size, size), Image.LANCZOS)


def make_icon(path: str, size: int = 160) -> None:
    rounded_card(size).save(path, "PNG")


def make_preview(path: str, width: int = 1200, height: int = 760) -> None:
    img = Image.new("RGBA", (width, height), (247, 249, 252, 255))
    d = ImageDraw.Draw(img)
    title_font = load_font(30)
    font = load_font(20)
    small = load_font(16)

    # 侧边栏
    d.rectangle([0, 0, 250, height], fill=(255, 255, 255, 255))
    d.line([250, 0, 250, height], fill=(226, 232, 240, 255), width=2)
    d.rounded_rectangle([24, 26, 58, 60], radius=10, fill=ACCENT)
    d.text((70, 30), "日历 · CalDAV", font=font, fill=OUTLINE)
    y = 110
    for label, color, checked in [
        ("工作 (Nextcloud)", ACCENT, True),
        ("个人 (iCloud)", SYNC, True),
        ("Radicale 本地", (232, 148, 62, 255), True),
        ("只读 · 节假日", (150, 160, 178, 255), False),
    ]:
        d.rounded_rectangle([24, y, 38, y + 14], radius=4, fill=color)
        d.text((50, y - 4), label, font=small, fill=(60, 72, 92, 255))
        if checked:
            d.line([28, y + 26, 34, y + 32, 44, y + 20], fill=ACCENT, width=3)
        y += 46
    d.text((24, height - 120), "同步：3 分钟前", font=small, fill=(120, 132, 152, 255))
    d.text((24, height - 90), "⇅ 双向 · 冲突：保留副本", font=small, fill=(120, 132, 152, 255))

    # 主区域标题
    d.text((290, 26), "2025 年 6 月", font=title_font, fill=OUTLINE)
    for i, label in enumerate(["月", "周", "日", "议程"]):
        x = 760 + i * 92
        fill = ACCENT if i == 0 else (255, 255, 255, 255)
        text_fill = (255, 255, 255, 255) if i == 0 else (90, 102, 122, 255)
        d.rounded_rectangle([x, 26, x + 80, 66], radius=10, fill=fill, outline=(220, 228, 240, 255))
        d.text((x + 26, 36), label, font=small, fill=text_fill)

    # 周标题
    week = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
    grid_left = 290
    grid_top = 100
    cell_w = (width - grid_left - 40) / 7
    cell_h = (height - grid_top - 40) / 6
    for i, name in enumerate(week):
        d.text((grid_left + i * cell_w + 12, grid_top - 28), name, font=small, fill=(120, 132, 152, 255))
    for r in range(6):
        for c in range(7):
            x0 = grid_left + c * cell_w
            y0 = grid_top + r * cell_h
            d.rectangle(
                [x0, y0, x0 + cell_w - 1, y0 + cell_h - 1],
                fill=(255, 255, 255, 255),
                outline=(232, 238, 246, 255),
            )
            day = r * 7 + c - 5
            if 1 <= day <= 30:
                is_today = day == 18
                if is_today:
                    d.ellipse([x0 + 10, y0 + 8, x0 + 44, y0 + 42], fill=ACCENT)
                d.text(
                    (x0 + 18, y0 + 14),
                    str(day),
                    font=small,
                    fill=(255, 255, 255, 255) if is_today else OUTLINE,
                )
                if day % 5 == 0:
                    d.rounded_rectangle(
                        [x0 + 10, y0 + 50, x0 + cell_w - 14, y0 + 78],
                        radius=6,
                        fill=(232, 240, 254, 255),
                    )
                    d.rounded_rectangle([x0 + 10, y0 + 50, x0 + 16, y0 + 78], radius=3, fill=ACCENT)
                    d.text((x0 + 24, y0 + 56), "09:00 周会", font=small, fill=(46, 62, 92, 255))
                if day % 7 == 3:
                    d.rounded_rectangle(
                        [x0 + 10, y0 + 84, x0 + cell_w - 14, y0 + 112],
                        radius=6,
                        fill=(230, 249, 242, 255),
                    )
                    d.rounded_rectangle([x0 + 10, y0 + 84, x0 + 16, y0 + 112], radius=3, fill=SYNC)
                    d.text((x0 + 24, y0 + 90), "全天 · 休假", font=small, fill=(24, 110, 84, 255))
    img.convert("RGB").save(path, "PNG")


if __name__ == "__main__":
    make_icon(os.path.join(ROOT, "icon.png"), 160)
    make_preview(os.path.join(ROOT, "preview.png"))
    print("generated icon.png, preview.png")

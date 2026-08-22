# Media kit

Committed files are **finals** (README / site / social). Remotion source lives in `promo/`; renders, TTS wavs, and font files stay local.

```
docs/media/
  title.png                 README hero
  architecture.svg          static labeled diagram
  architecture-flow.gif     looping packet flow
  architecture.png          1920×1080 still of the fan-out scene
  principle.png             local vs cloud still
  setup.png                 four-step setup still
  architecture.mp4          30s silent explainer
  intro-zh.mp4              official site (洞白)
  intro-en.mp4              Twitter
  intro-zh-douyin.mp4       Douyin 9:16
  brand/                    logos / favicons
  promo/                    Remotion source (src, scripts, package.json)
```

Not committed (see repo `.gitignore`): `promo/out/`, `promo/vo/**/*.wav`, `promo/public/fonts/`, `brand-preview/`.

## Use in README

```md
![Fleet architecture](docs/media/architecture.svg)
![How a command travels](docs/media/architecture-flow.gif)
```

GitHub does not autoplay MP4 in READMEs. Keep the GIF in the README.

## Re-render

Windows: Remotion is pointed at Edge in `promo/remotion.config.ts`. Fonts are local under `promo/public/fonts/` (not in git).

```bash
cd docs/media/promo
npm install
npm run studio
npm run render          # out/architecture.mp4
npm run render:loop     # out/flow-loop.mp4
npm run render:intro-zh
npm run render:intro-en
npm run render:intro-zhdy
```

Then copy / convert into this folder:

```bash
ffmpeg -y -i out/flow-loop.mp4 -vf "fps=12,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=full:reserve_transparent=0[p];[s1][p]paletteuse=dither=none" ../architecture-flow.gif
npx remotion still Architecture ../architecture.png --frame=200
npx remotion still Architecture ../title.png --frame=55
npx remotion still Architecture ../setup.png --frame=520
npx remotion still Architecture ../principle.png --frame=670
copy out\architecture.mp4 ..\architecture.mp4
python scripts/mux_intro.py zh en zhdy
copy out\intro-zh.mp4 ..\intro-zh.mp4
copy out\intro-en.mp4 ..\intro-en.mp4
copy out\intro-zhdy.mp4 ..\intro-zh-douyin.mp4
```

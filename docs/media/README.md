# Media kit

Assets for the README, docs, and a later intro video. Diagrams are drawn in code (SVG + Remotion) so labels stay exact.

```
docs/media/
  title.png                 README hero / video title card
  architecture.svg          static labeled diagram (README)
  architecture-flow.gif     looping packet flow (README)
  architecture.png          1920×1080 still of the round-trip scene
  principle.png             outbound-only still
  setup.png                 four-step setup still
  architecture.mp4          30s explainer (silent; seed for the later video)
  SCRIPT.md                 voiceover + shot list for that video
  promo/                    Remotion source — re-render from here
```

## Use in README

```md
![Fleet architecture](docs/media/architecture.svg)
![How a command travels](docs/media/architecture-flow.gif)
```

GitHub does not autoplay MP4 in READMEs. Keep the GIF in the README; host the MP4 on GitHub Releases or YouTube when the spoken intro is ready.

## Re-render

Windows: Remotion is pointed at Edge in `promo/remotion.config.ts`.

```bash
cd docs/media/promo
npm install
npm run studio          # preview
npm run render          # out/architecture.mp4
npm run render:loop     # out/flow-loop.mp4
npm run still           # out/architecture.png  (frame 200 = fan-out scene)
```

Then copy / convert into this folder:

```bash
ffmpeg -y -i out/flow-loop.mp4 -vf "fps=12,eq=brightness=0.04:contrast=1.08,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=full:reserve_transparent=0[p];[s1][p]paletteuse=dither=none" ../architecture-flow.gif
npx remotion still Architecture ../architecture.png --frame=200
npx remotion still Architecture ../title.png --frame=55
npx remotion still Architecture ../setup.png --frame=520
npx remotion still Architecture ../principle.png --frame=670
copy out\architecture.mp4 ..\architecture.mp4
```

`promo/node_modules` and `promo/out` are not committed.

## Later intro video

See [SCRIPT.md](SCRIPT.md). The 24s MP4 is the visual bed: add voiceover + optional screen recordings of login / token / agent tray.

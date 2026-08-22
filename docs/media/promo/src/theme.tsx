import React, {useEffect, useState} from 'react';
import {continueRender, delayRender, staticFile} from 'remotion';

/** OpenAI-like light: white / gray / black, purple only on the moving dots. */
export const PURPLE = '#8B5CFF';
export const TEXT = '#111111';
export const MUTED = '#6B6B6B';
export const PANEL = '#F4F4F4';
export const LINE = '#E6E6E6';
export const BG = '#FFFFFF';
export const INK = '#2A2A2A';
export const HAIR = '#D4D4D4';
export const LIFT = '#FFFFFF';
export const DEAD = '#B0B0B0';
export const DEAD_BG = '#EFEFEF';

export const MINT = '#111111';
export const BLUE = '#4A4A4A';
export const AMBER = '#2E2E2E';
export const ROSE = '#6B6B6B';

/** Frontend sans: Inter + Noto Sans SC for CJK. Used on big titles and box titles. */
export const FONT_TITLE = '"Inter", "Noto Sans SC", sans-serif';
/** Excalidraw handwriting: Excalifont (Latin) + Xiaolai (CJK). Used everywhere else. */
export const FONT_HAND = '"Excalifont", "Xiaolai", cursive';
/** Default body/kicker/caption stack. */
export const FONT = FONT_HAND;

let fontsPromise: Promise<void> | null = null;

const loadFonts = (): Promise<void> => {
  if (typeof document === 'undefined') return Promise.resolve();
  if (fontsPromise) return fontsPromise;
  const faces: FontFace[] = [
    new FontFace('Inter', `url(${staticFile('fonts/Inter-latin-wght.woff2')}) format('woff2')`, {
      weight: '100 900',
      style: 'normal',
    }),
    new FontFace('Noto Sans SC', `url(${staticFile('fonts/NotoSansSC-wght.ttf')}) format('truetype')`, {
      weight: '100 900',
      style: 'normal',
    }),
    new FontFace('Excalifont', `url(${staticFile('fonts/Excalifont-Regular.woff2')}) format('woff2')`, {
      weight: '400',
      style: 'normal',
    }),
    new FontFace('Xiaolai', `url(${staticFile('fonts/Xiaolai-Regular.ttf')}) format('truetype')`, {
      weight: '400',
      style: 'normal',
    }),
  ];
  fontsPromise = Promise.all(faces.map((face) => face.load().then((ready) => document.fonts.add(ready)))).then(
    () => undefined,
  );
  return fontsPromise;
};

const WaitFonts: React.FC = () => {
  const [handle] = useState(() => delayRender('WaitFonts'));
  useEffect(() => {
    loadFonts()
      .then(() => continueRender(handle))
      .catch((err) => {
        console.error(err);
        continueRender(handle);
      });
  }, [handle]);
  return null;
};

export const fadeInOut = (
  frame: number,
  total: number,
  fade = 14,
): number => {
  const t = Math.max(0, Math.min(total, frame));
  if (t < fade) return t / fade;
  if (t > total - fade) return (total - t) / fade;
  return 1;
};

export const OpenBg: React.FC<{width: number; height: number; frame: number}> = ({
  width,
  height,
  frame,
}) => {
  const pulse = 0.4 + 0.22 * Math.sin(frame / 40);
  const dots = [
    {x: 0.12, y: 0.18, r: 3},
    {x: 0.78, y: 0.14, r: 2},
    {x: 0.91, y: 0.42, r: 3.5},
    {x: 0.18, y: 0.62, r: 2.5},
    {x: 0.52, y: 0.08, r: 2},
    {x: 0.64, y: 0.78, r: 3},
    {x: 0.08, y: 0.88, r: 2},
    {x: 0.86, y: 0.72, r: 2.5},
    {x: 0.4, y: 0.92, r: 2},
  ];
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: `radial-gradient(90% 60% at 50% -10%, #F2F2F2 0%, ${BG} 58%)`,
      }}
    >
      <WaitFonts />
      <svg width={width} height={height} style={{position: 'absolute', inset: 0, opacity: 0.9}}>
        {Array.from({length: Math.ceil(width / 108) + 1}).map((_, i) => (
          <line key={`v${i}`} x1={108 * i} y1={0} x2={108 * i} y2={height} stroke={LINE} strokeWidth="1" />
        ))}
        {Array.from({length: Math.ceil(height / 108) + 1}).map((_, i) => (
          <line key={`h${i}`} x1={0} y1={108 * i} x2={width} y2={108 * i} stroke={LINE} strokeWidth="1" />
        ))}
        {dots.map((d, i) => (
          <circle
            key={i}
            cx={d.x * width}
            cy={d.y * height}
            r={d.r}
            fill={PURPLE}
            opacity={pulse * (i % 2 === 0 ? 1 : 0.65)}
          />
        ))}
      </svg>
    </div>
  );
};

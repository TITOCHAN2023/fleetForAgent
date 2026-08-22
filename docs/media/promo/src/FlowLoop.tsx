import React from 'react';
import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {AMBER, BG, BLUE, FONT, FONT_TITLE, HAIR, MINT, MUTED, OpenBg, PANEL, PURPLE, ROSE, TEXT} from './theme';

const Card: React.FC<{
  x: number;
  y: number;
  w?: number;
  h?: number;
  color: string;
  kicker: string;
  title: string;
  sub: string;
  delay: number;
}> = ({x, y, w = 280, h = 150, color, kicker, title, sub, delay}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const s = spring({frame: frame - delay, fps, config: {damping: 14}});
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: w,
        height: h,
        opacity: 1,
        transform: `scale(${0.96 + s * 0.04})`,
        borderRadius: 18,
        border: `1.5px solid ${HAIR}`,
        background: PANEL,
        boxShadow: '0 10px 28px rgba(0,0,0,0.06)',
        padding: 16,
        fontFamily: FONT,
      }}
    >
      <div style={{color, fontSize: 13, fontWeight: 700, letterSpacing: 1.4}}>{kicker}</div>
      <div style={{color: TEXT, fontSize: 24, fontWeight: 800, marginTop: 6, fontFamily: FONT_TITLE}}>{title}</div>
      <div style={{color: MUTED, fontSize: 14, marginTop: 6}}>{sub}</div>
    </div>
  );
};

export const FlowLoop: React.FC = () => {
  const frame = useCurrentFrame();
  const t = (frame % 80) / 80;
  // Looping GIF: cards stay fully opaque so frame 0 is not a fade-in.
  const go = interpolate(t, [0.05, 0.45], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const back = interpolate(t, [0.5, 0.9], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const dot = (p: number, x1: number, y1: number, x2: number, y2: number, color: string) => {
    const u = Math.max(0, Math.min(1, p));
    if (u <= 0 || u >= 1) return null;
    return (
      <div
        style={{
          position: 'absolute',
          left: x1 + (x2 - x1) * u - 7,
          top: y1 + (y2 - y1) * u - 7,
          width: 14,
          height: 14,
          borderRadius: 99,
          background: color,
          boxShadow: `0 0 14px ${color}`,
        }}
      />
    );
  };
  return (
    <AbsoluteFill
      style={{
        background: BG,
        fontFamily: FONT,
      }}
    >
      <OpenBg width={1280} height={720} frame={frame} />
      <div
        style={{
          position: 'absolute',
          top: 28,
          width: '100%',
          textAlign: 'center',
          color: TEXT,
          fontSize: 28,
          fontWeight: 800,
          fontFamily: FONT_TITLE,
        }}
      >
        One tool → fleet.ginfo.cc → Windows / Linux / macOS
      </div>
      <svg width="1280" height="720" style={{position: 'absolute', inset: 0}}>
        <path d="M 310 360 H 470" stroke={AMBER} strokeWidth="4" fill="none" />
        <path d="M 780 280 L 920 160" stroke={BLUE} strokeWidth="3" fill="none" />
        <path d="M 780 360 H 920" stroke={MINT} strokeWidth="3" fill="none" />
        <path d="M 780 440 L 920 560" stroke={ROSE} strokeWidth="3" fill="none" />
      </svg>
      <Card x={40} y={260} w={270} h={200} color={AMBER} delay={0} kicker="TOOL" title="Cursor / Claude" sub="HTTPS + token" />
      <Card x={490} y={240} w={290} h={240} color={MINT} delay={0} kicker="SERVER" title="fleet.ginfo.cc" sub="WSS to every Agent" />
      <Card x={920} y={80} color={BLUE} delay={0} kicker="WINDOWS" title="amd64" sub="dial-out WebSocket" />
      <Card x={920} y={280} color={MINT} delay={0} kicker="LINUX" title="amd64 / arm64" sub="dial-out WebSocket" />
      <Card x={920} y={480} color={ROSE} delay={0} kicker="MACOS" title="arm64 / amd64" sub="dial-out WebSocket" />
      {dot(go < 0.35 ? go / 0.35 : 1, 310, 360, 490, 360, PURPLE)}
      {dot(go > 0.3 ? (go - 0.3) / 0.7 : 0, 780, 280, 920, 160, PURPLE)}
      {dot(go > 0.35 ? (go - 0.35) / 0.65 : 0, 780, 360, 920, 360, PURPLE)}
      {dot(go > 0.4 ? (go - 0.4) / 0.6 : 0, 780, 440, 920, 560, PURPLE)}
      {dot(back, 920, 185, 780, 300, PURPLE)}
      {dot(back > 0.05 ? (back - 0.05) / 0.95 : 0, 920, 360, 780, 360, PURPLE)}
      {dot(back > 0.1 ? (back - 0.1) / 0.9 : 0, 920, 560, 780, 420, PURPLE)}
      {dot(back > 0.45 ? (back - 0.45) / 0.55 : 0, 490, 360, 310, 360, PURPLE)}
      <div
        style={{
          position: 'absolute',
          bottom: 28,
          width: '100%',
          textAlign: 'center',
          color: MUTED,
          fontSize: 18,
        }}
      >
        Import the tool with URL + token. Reach every Agent from anywhere.
      </div>
    </AbsoluteFill>
  );
};

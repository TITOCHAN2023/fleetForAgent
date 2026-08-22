import React from 'react';
import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {AMBER, BLUE, FONT, MINT, MUTED, TEXT} from './theme';

const Card: React.FC<{
  x: number;
  y: number;
  color: string;
  kicker: string;
  title: string;
  sub: string;
  delay: number;
}> = ({x, y, color, kicker, title, sub, delay}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const s = spring({frame: frame - delay, fps, config: {damping: 14}});
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: 300,
        height: 210,
        opacity: Math.max(s, 0.15),
        transform: `scale(${0.94 + s * 0.06})`,
        borderRadius: 22,
        border: `2.5px solid ${color}`,
        background: `linear-gradient(165deg, ${color}55, #182236)`,
        boxShadow: `0 12px 40px ${color}55`,
        padding: 22,
        fontFamily: FONT,
      }}
    >
      <div style={{color, fontSize: 14, fontWeight: 700, letterSpacing: 1.6}}>{kicker}</div>
      <div style={{color: TEXT, fontSize: 28, fontWeight: 800, marginTop: 10}}>{title}</div>
      <div style={{color: MUTED, fontSize: 16, marginTop: 8}}>{sub}</div>
    </div>
  );
};

export const FlowLoop: React.FC = () => {
  const frame = useCurrentFrame();
  const cycle = 80;
  const t = frame % cycle;
  const go = interpolate(t, [6, 36], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const back = interpolate(t, [42, 72], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const dot = (p: number, x1: number, y1: number, x2: number, y2: number, color: string) => {
    const u = Math.max(0, Math.min(1, p));
    if (u <= 0 || u >= 1) return null;
    return (
      <div
        key={`${color}-${x1}-${y1}`}
        style={{
          position: 'absolute',
          left: x1 + (x2 - x1) * u - 8,
          top: y1 + (y2 - y1) * u - 8,
          width: 16,
          height: 16,
          borderRadius: 99,
          background: color,
          boxShadow: `0 0 16px ${color}`,
        }}
      />
    );
  };
  return (
    <AbsoluteFill
      style={{
        background: 'radial-gradient(90% 80% at 50% 0%, #16324a 0%, #070b14 55%, #05070c 100%)',
        fontFamily: FONT,
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 36,
          width: '100%',
          textAlign: 'center',
          color: TEXT,
          fontSize: 32,
          fontWeight: 800,
        }}
      >
        Devices dial out. The website is the hub.
      </div>
      <svg width="1280" height="720" style={{position: 'absolute', inset: 0}}>
        <path d="M 350 345 H 490" stroke={AMBER} strokeWidth="5" fill="none" opacity={0.95} />
        <path d="M 790 345 H 930" stroke={BLUE} strokeWidth="5" fill="none" opacity={0.95} />
        <path d="M 930 415 H 790" stroke={MINT} strokeWidth="4" fill="none" opacity={0.7} />
        <path d="M 490 415 H 350" stroke={MINT} strokeWidth="4" fill="none" opacity={0.7} />
      </svg>
      <Card
        x={50}
        y={250}
        color={AMBER}
        delay={0}
        kicker="YOU"
        title="Cursor / Claude"
        sub="HTTPS + flt_ token"
      />
      <Card
        x={490}
        y={230}
        color={MINT}
        delay={0}
        kicker="HUB"
        title="This website"
        sub="/v1  ·  account-scoped"
      />
      <Card
        x={930}
        y={250}
        color={BLUE}
        delay={0}
        kicker="DEVICE"
        title="Fleet Agent"
        sub="Outbound WSS only"
      />
      {dot(go < 0.5 ? go * 2 : 1, 350, 345, 490, 345, AMBER)}
      {dot(go > 0.5 ? (go - 0.5) * 2 : 0, 790, 345, 930, 345, MINT)}
      {dot(back < 0.5 ? back * 2 : 1, 930, 415, 790, 415, BLUE)}
      {dot(back > 0.5 ? (back - 0.5) * 2 : 0, 490, 415, 350, 415, MINT)}
      <div
        style={{
          position: 'absolute',
          bottom: 40,
          width: '100%',
          textAlign: 'center',
          color: MUTED,
          fontSize: 20,
        }}
      >
        MCP → Hub → Agent → result. No inbound ports.
      </div>
    </AbsoluteFill>
  );
};

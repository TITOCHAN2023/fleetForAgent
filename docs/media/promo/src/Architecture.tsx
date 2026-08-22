import React from 'react';
import {
  AbsoluteFill,
  Easing,
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {AMBER, BLUE, FONT, MINT, MUTED, TEXT, fadeInOut} from './theme';

const Background: React.FC = () => {
  const frame = useCurrentFrame();
  const shift = Math.sin(frame / 80) * 10;
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(110% 90% at ${48 + shift}% -10%, #16324a 0%, #070b14 42%, #05070c 100%)`,
      }}
    >
      <svg width="1920" height="1080" style={{position: 'absolute', inset: 0, opacity: 0.18}}>
        {Array.from({length: 16}).map((_, i) => (
          <line
            key={`v${i}`}
            x1={120 * i}
            y1={0}
            x2={120 * i}
            y2={1080}
            stroke="#6ea8ff"
            strokeWidth="1"
          />
        ))}
        {Array.from({length: 10}).map((_, i) => (
          <line
            key={`h${i}`}
            x1={0}
            y1={108 * i}
            x2={1920}
            y2={108 * i}
            stroke="#6ea8ff"
            strokeWidth="1"
          />
        ))}
      </svg>
    </AbsoluteFill>
  );
};

const Wordmark: React.FC<{opacity?: number}> = ({opacity = 1}) => (
  <div
    style={{
      position: 'absolute',
      top: 36,
      left: 56,
      opacity,
      fontFamily: FONT,
      letterSpacing: 3,
      fontSize: 22,
      fontWeight: 700,
      color: MINT,
    }}
  >
    FLEET
  </div>
);

const NodeCard: React.FC<{
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  kicker: string;
  title: string;
  sub: string;
  delay: number;
}> = ({x, y, w, h, color, kicker, title, sub, delay}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const s = spring({frame: frame - delay, fps, config: {damping: 14, mass: 0.8}});
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: w,
        height: h,
        opacity: s,
        transform: `translateY(${(1 - s) * 28}px) scale(${0.92 + s * 0.08})`,
        borderRadius: 28,
        border: `2px solid ${color}`,
        background: `linear-gradient(165deg, ${color}40, #152033f2)`,
        boxShadow: `0 18px 60px ${color}33, inset 0 1px 0 #ffffff22`,
        padding: 28,
        fontFamily: FONT,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 8,
      }}
    >
      <div style={{color, fontSize: 18, fontWeight: 700, letterSpacing: 2}}>{kicker}</div>
      <div style={{color: TEXT, fontSize: 40, fontWeight: 800, lineHeight: 1.1}}>{title}</div>
      <div style={{color: MUTED, fontSize: 22, fontWeight: 500}}>{sub}</div>
    </div>
  );
};

const Packet: React.FC<{
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  progress: number;
  color: string;
  label?: string;
}> = ({x1, y1, x2, y2, progress, color, label}) => {
  const p = Math.max(0, Math.min(1, progress));
  if (p <= 0 || p >= 1) return null;
  const x = x1 + (x2 - x1) * p;
  const y = y1 + (y2 - y1) * p;
  return (
    <div
      style={{
        position: 'absolute',
        left: x - 10,
        top: y - 10,
        width: 20,
        height: 20,
        borderRadius: 999,
        background: color,
        boxShadow: `0 0 22px ${color}`,
      }}
    >
      {label ? (
        <div
          style={{
            position: 'absolute',
            left: 24,
            top: -18,
            color,
            fontFamily: FONT,
            fontSize: 18,
            fontWeight: 700,
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </div>
      ) : null}
    </div>
  );
};

const SceneTitle: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const a = spring({frame, fps, config: {damping: 16}});
  const b = spring({frame: frame - 12, fps, config: {damping: 16}});
  const c = interpolate(frame, [28, 48], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <AbsoluteFill
      style={{
        justifyContent: 'center',
        alignItems: 'center',
        fontFamily: FONT,
        opacity: fadeInOut(frame, 90, 12),
      }}
    >
      <div
        style={{
          fontSize: 28,
          letterSpacing: 8,
          color: MINT,
          fontWeight: 700,
          opacity: a,
          marginBottom: 18,
        }}
      >
        FLEET FOR AGENT
      </div>
      <div
        style={{
          fontSize: 92,
          fontWeight: 900,
          color: TEXT,
          opacity: b,
          transform: `translateY(${(1 - b) * 24}px)`,
          textAlign: 'center',
          lineHeight: 1.05,
        }}
      >
        Your agent, on your machines.
      </div>
      <div
        style={{
          marginTop: 28,
          fontSize: 36,
          color: MUTED,
          opacity: c,
        }}
      >
        Devices dial out only. No inbound ports. No VPS required.
      </div>
    </AbsoluteFill>
  );
};

const SceneTopology: React.FC = () => {
  const frame = useCurrentFrame();
  const line = interpolate(frame, [24, 52], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });
  const caption = interpolate(frame, [60, 80], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <AbsoluteFill style={{opacity: fadeInOut(frame, 150, 12), fontFamily: FONT}}>
      <Wordmark />
      <div
        style={{
          position: 'absolute',
          top: 110,
          width: '100%',
          textAlign: 'center',
          color: TEXT,
          fontSize: 42,
          fontWeight: 800,
        }}
      >
        Three pieces. One hub.
      </div>
      <svg width="1920" height="1080" style={{position: 'absolute', inset: 0}}>
        <defs>
          <linearGradient id="g1" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={AMBER} />
            <stop offset="100%" stopColor={MINT} />
          </linearGradient>
          <linearGradient id="g2" x1="1" y1="0" x2="0" y2="0">
            <stop offset="0%" stopColor={BLUE} />
            <stop offset="100%" stopColor={MINT} />
          </linearGradient>
        </defs>
        <path
          d="M 520 540 H 770"
          stroke="url(#g1)"
          strokeWidth="5"
          pathLength={1}
          strokeDasharray={`${line} ${Math.max(0, 1 - line)}`}
          fill="none"
          opacity={0.95}
        />
        <path
          d="M 1400 540 H 1150"
          stroke="url(#g2)"
          strokeWidth="5"
          pathLength={1}
          strokeDasharray={`${line} ${Math.max(0, 1 - line)}`}
          fill="none"
          opacity={0.95}
        />
      </svg>
      <NodeCard
        x={120}
        y={400}
        w={400}
        h={280}
        color={AMBER}
        delay={8}
        kicker="YOU"
        title="Cursor / Claude"
        sub="MCP operator · HTTPS + token"
      />
      <NodeCard
        x={760}
        y={360}
        w={400}
        h={360}
        color={MINT}
        delay={22}
        kicker="HUB"
        title="This website"
        sub="Login · mint token · route jobs"
      />
      <NodeCard
        x={1400}
        y={400}
        w={400}
        h={280}
        color={BLUE}
        delay={36}
        kicker="DEVICE"
        title="Fleet Agent"
        sub="Mac / Windows / Linux · outbound WSS"
      />
      <div
        style={{
          position: 'absolute',
          bottom: 90,
          width: '100%',
          textAlign: 'center',
          color: MUTED,
          fontSize: 28,
          opacity: caption,
        }}
      >
        Website is the hub. Agents never open a port on your LAN.
      </div>
    </AbsoluteFill>
  );
};

const ScenePacket: React.FC = () => {
  const frame = useCurrentFrame();
  const cycle = 90;
  const t = frame % cycle;
  const outbound = interpolate(t, [8, 40], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const inbound = interpolate(t, [48, 80], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const step = t < 45 ? 'run → hub → agent' : 'result ← hub ← agent';
  return (
    <AbsoluteFill style={{opacity: fadeInOut(frame, 210, 12), fontFamily: FONT}}>
      <Wordmark />
      <div
        style={{
          position: 'absolute',
          top: 110,
          width: '100%',
          textAlign: 'center',
          color: TEXT,
          fontSize: 42,
          fontWeight: 800,
        }}
      >
        A command is just a round trip
      </div>
      <svg width="1920" height="1080" style={{position: 'absolute', inset: 0, opacity: 0.9}}>
        <path d="M 520 540 H 770" stroke={AMBER} strokeWidth="4" fill="none" opacity={0.55} />
        <path d="M 1400 540 H 1150" stroke={BLUE} strokeWidth="4" fill="none" opacity={0.55} />
      </svg>
      <NodeCard
        x={120}
        y={400}
        w={400}
        h={280}
        color={AMBER}
        delay={0}
        kicker="MCP"
        title="list / run / type"
        sub="FLEET_URL + FLEET_TOKEN"
      />
      <NodeCard
        x={760}
        y={380}
        w={400}
        h={320}
        color={MINT}
        delay={0}
        kicker="HUB"
        title="/v1/run"
        sub="scopes every row by your account"
      />
      <NodeCard
        x={1400}
        y={400}
        w={400}
        h={280}
        color={BLUE}
        delay={0}
        kicker="AGENT"
        title="executes locally"
        sub="WSS /v1/device · dial-out only"
      />
      <Packet
        x1={520}
        y1={540}
        x2={770}
        y2={540}
        progress={outbound < 0.5 ? outbound * 2 : 1}
        color={AMBER}
        label={outbound > 0.05 && outbound < 0.5 ? 'run' : undefined}
      />
      <Packet
        x1={1150}
        y1={540}
        x2={1400}
        y2={540}
        progress={outbound > 0.5 ? (outbound - 0.5) * 2 : 0}
        color={MINT}
        label={outbound > 0.55 && outbound < 0.95 ? 'job' : undefined}
      />
      <Packet
        x1={1400}
        y1={600}
        x2={1150}
        y2={600}
        progress={inbound < 0.5 ? inbound * 2 : 1}
        color={BLUE}
        label={inbound > 0.05 && inbound < 0.5 ? 'stdout' : undefined}
      />
      <Packet
        x1={770}
        y1={600}
        x2={520}
        y2={600}
        progress={inbound > 0.5 ? (inbound - 0.5) * 2 : 0}
        color={MINT}
        label={inbound > 0.55 && inbound < 0.95 ? 'result' : undefined}
      />
      <div
        style={{
          position: 'absolute',
          bottom: 90,
          width: '100%',
          textAlign: 'center',
          color: MINT,
          fontSize: 30,
          fontWeight: 700,
        }}
      >
        {step}
      </div>
    </AbsoluteFill>
  );
};

const ScenePrinciple: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const items = [
    {t: 'No inbound ports on your machines', d: 0},
    {t: 'No public IP / VPS required for agents', d: 10},
    {t: 'Google / X login · Hub token per account', d: 20},
    {t: 'Cursor, Claude, or any MCP client', d: 30},
  ];
  return (
    <AbsoluteFill
      style={{
        justifyContent: 'center',
        alignItems: 'center',
        fontFamily: FONT,
        opacity: fadeInOut(frame, 120, 12),
        gap: 22,
      }}
    >
      <div style={{fontSize: 52, fontWeight: 900, color: TEXT, marginBottom: 20}}>
        Designed around outbound-only
      </div>
      {items.map((it) => {
        const s = spring({frame: frame - it.d, fps, config: {damping: 14}});
        return (
          <div
            key={it.t}
            style={{
              opacity: s,
              transform: `translateX(${(1 - s) * -40}px)`,
              width: 980,
              padding: '20px 28px',
              borderRadius: 16,
              border: `1px solid ${MINT}44`,
              borderLeft: `6px solid ${MINT}`,
              background: '#ffffff08',
              color: TEXT,
              fontSize: 32,
              fontWeight: 600,
            }}
          >
            {it.t}
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

const SceneSetup: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const steps = [
    {n: '01', t: 'Log in', s: 'Google / X on the website'},
    {n: '02', t: 'Mint a Hub token', s: 'Settings · shown once'},
    {n: '03', t: 'Install Agent', s: 'Paste origin + token'},
    {n: '04', t: 'Point MCP at it', s: 'FLEET_URL + FLEET_TOKEN'},
  ];
  return (
    <AbsoluteFill
      style={{
        fontFamily: FONT,
        opacity: fadeInOut(frame, 150, 14),
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <div style={{fontSize: 48, fontWeight: 900, color: TEXT, marginBottom: 48}}>
        Four steps. Same origin, same token.
      </div>
      <div style={{display: 'flex', gap: 22}}>
        {steps.map((st, i) => {
          const s = spring({frame: frame - i * 12, fps, config: {damping: 13}});
          return (
            <div
              key={st.n}
              style={{
                width: 340,
                height: 280,
                opacity: s,
                transform: `translateY(${(1 - s) * 24}px)`,
                borderRadius: 24,
                background: '#101826',
                border: `1px solid ${BLUE}55`,
                padding: 28,
              }}
            >
              <div style={{color: MINT, fontSize: 22, fontWeight: 800, letterSpacing: 2}}>
                {st.n}
              </div>
              <div style={{color: TEXT, fontSize: 34, fontWeight: 800, marginTop: 18}}>
                {st.t}
              </div>
              <div style={{color: MUTED, fontSize: 22, marginTop: 12}}>{st.s}</div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

export const Architecture: React.FC = () => {
  return (
    <AbsoluteFill style={{background: '#070b14'}}>
      <Background />
      <Sequence from={0} durationInFrames={90}>
        <SceneTitle />
      </Sequence>
      <Sequence from={90} durationInFrames={150}>
        <SceneTopology />
      </Sequence>
      <Sequence from={240} durationInFrames={210}>
        <ScenePacket />
      </Sequence>
      <Sequence from={450} durationInFrames={120}>
        <ScenePrinciple />
      </Sequence>
      <Sequence from={570} durationInFrames={150}>
        <SceneSetup />
      </Sequence>
    </AbsoluteFill>
  );
};

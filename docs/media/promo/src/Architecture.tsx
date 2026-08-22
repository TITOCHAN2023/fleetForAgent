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
import {AMBER, BG, BLUE, FONT, FONT_TITLE, HAIR, LIFT, MINT, MUTED, OpenBg, PANEL, PURPLE, ROSE, TEXT, fadeInOut} from './theme';

const Background: React.FC = () => {
  const frame = useCurrentFrame();
  const {width, height} = useVideoConfig();
  return <OpenBg width={width} height={height} frame={frame} />;
};

const Wordmark: React.FC = () => (
  <div
    style={{
      position: 'absolute',
      top: 36,
      left: 56,
      fontFamily: FONT,
      letterSpacing: 3,
      fontSize: 22,
      fontWeight: 700,
      color: TEXT,
      fontFamily: FONT_TITLE,
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
        transform: `translateY(${(1 - s) * 24}px) scale(${0.94 + s * 0.06})`,
        borderRadius: 24,
        border: `1.5px solid ${HAIR}`,
        background: PANEL,
        boxShadow: '0 12px 32px rgba(0,0,0,0.06)',
        padding: 22,
        fontFamily: FONT,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 6,
      }}
    >
      <div style={{color, fontSize: 16, fontWeight: 700, letterSpacing: 2}}>{kicker}</div>
      <div style={{color: TEXT, fontSize: 32, fontWeight: 800, lineHeight: 1.15, fontFamily: FONT_TITLE}}>{title}</div>
      <div style={{color: MUTED, fontSize: 18, fontWeight: 500}}>{sub}</div>
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
}> = ({x1, y1, x2, y2, progress, color}) => {
  const p = Math.max(0, Math.min(1, progress));
  if (p <= 0 || p >= 1) return null;
  return (
    <div
      style={{
        position: 'absolute',
        left: x1 + (x2 - x1) * p - 8,
        top: y1 + (y2 - y1) * p - 8,
        width: 16,
        height: 16,
        borderRadius: 999,
        background: color,
        boxShadow: `0 0 18px ${color}`,
      }}
    />
  );
};

const SceneTitle: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const a = spring({frame, fps, config: {damping: 16}});
  const b = spring({frame: frame - 10, fps, config: {damping: 16}});
  const c = interpolate(frame, [28, 48], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  return (
    <AbsoluteFill
      style={{
        justifyContent: 'center',
        alignItems: 'center',
        fontFamily: FONT,
        opacity: fadeInOut(frame, 90, 12),
      }}
    >
      <div style={{fontSize: 26, letterSpacing: 6, color: MINT, fontWeight: 700, opacity: a, marginBottom: 16}}>
        FLEET.GINFO.CC
      </div>
      <div
        style={{
          fontSize: 78,
          fontWeight: 900,
          color: TEXT,
          fontFamily: FONT_TITLE,
          opacity: b,
          transform: `translateY(${(1 - b) * 24}px)`,
          textAlign: 'center',
          lineHeight: 1.08,
        }}
      >
        One tool. Every computer.
        <br />
        Anywhere.
      </div>
      <div style={{marginTop: 28, fontSize: 32, color: MUTED, opacity: c}}>
        Windows · Linux · macOS · any arch · one token
      </div>
    </AbsoluteFill>
  );
};

const FanLines: React.FC<{grow: number}> = ({grow}) => (
  <svg width="1920" height="1080" style={{position: 'absolute', inset: 0}}>
    <path d="M 430 540 H 700" stroke={AMBER} strokeWidth="5" pathLength={1} strokeDasharray={`${grow} ${1 - grow}`} fill="none" />
    <path d="M 1120 420 L 1380 250" stroke={BLUE} strokeWidth="4" pathLength={1} strokeDasharray={`${grow} ${1 - grow}`} fill="none" />
    <path d="M 1120 540 H 1380" stroke={MINT} strokeWidth="4" pathLength={1} strokeDasharray={`${grow} ${1 - grow}`} fill="none" />
    <path d="M 1120 660 L 1380 830" stroke={ROSE} strokeWidth="4" pathLength={1} strokeDasharray={`${grow} ${1 - grow}`} fill="none" />
  </svg>
);

const SceneFan: React.FC = () => {
  const frame = useCurrentFrame();
  const grow = interpolate(frame, [18, 55], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });
  return (
    <AbsoluteFill style={{opacity: fadeInOut(frame, 180, 12), fontFamily: FONT}}>
      <Wordmark />
      <div style={{position: 'absolute', top: 88, width: '100%', textAlign: 'center', color: TEXT, fontSize: 40, fontWeight: 800, fontFamily: FONT_TITLE}}>
        Tool → cloud hub → every OS over WebSocket
      </div>
      <FanLines grow={grow} />
      <NodeCard x={80} y={390} w={350} h={300} color={AMBER} delay={4} kicker="TOOL" title="Cursor / Claude" sub="MCP · HTTPS + token" />
      <NodeCard x={720} y={360} w={400} h={360} color={MINT} delay={16} kicker="SERVER" title="fleet.ginfo.cc" sub="Cloud hub · WSS /v1/device" />
      <NodeCard x={1380} y={150} w={460} h={180} color={BLUE} delay={28} kicker="WINDOWS" title="amd64 Agent" sub="outbound WebSocket" />
      <NodeCard x={1380} y={400} w={460} h={180} color={MINT} delay={36} kicker="LINUX" title="amd64 / arm64 Agent" sub="outbound WebSocket" />
      <NodeCard x={1380} y={650} w={460} h={180} color={ROSE} delay={44} kicker="MACOS" title="arm64 / amd64 Agent" sub="outbound WebSocket" />
      <div style={{position: 'absolute', bottom: 48, width: '100%', textAlign: 'center', color: MUTED, fontSize: 26}}>
        Devices only dial out. No inbound ports. Any arch that can run the Agent joins the same fleet.
      </div>
    </AbsoluteFill>
  );
};

const ScenePackets: React.FC = () => {
  const frame = useCurrentFrame();
  const t = (frame % 70) / 70;
  return (
    <AbsoluteFill style={{opacity: fadeInOut(frame, 180, 12), fontFamily: FONT}}>
      <Wordmark />
      <div style={{position: 'absolute', top: 88, width: '100%', textAlign: 'center', color: TEXT, fontSize: 40, fontWeight: 800, fontFamily: FONT_TITLE}}>
        Pick a machine. Run. Get the result. From anywhere.
      </div>
      <FanLines grow={1} />
      <NodeCard x={80} y={390} w={350} h={300} color={AMBER} delay={0} kicker="TOOL" title="list / run / type" sub="FLEET_URL + FLEET_TOKEN" />
      <NodeCard x={720} y={360} w={400} h={360} color={MINT} delay={0} kicker="HUB" title="relay" sub="one account · many hosts" />
      <NodeCard x={1380} y={150} w={460} h={180} color={BLUE} delay={0} kicker="WIN" title="MySuperPC" sub="executes locally" />
      <NodeCard x={1380} y={400} w={460} h={180} color={MINT} delay={0} kicker="LINUX" title="colo box" sub="executes locally" />
      <NodeCard x={1380} y={650} w={460} h={180} color={ROSE} delay={0} kicker="MAC" title="888-test" sub="executes locally" />
      <Packet x1={430} y1={540} x2={720} y2={540} progress={t < 0.28 ? t / 0.28 : 1} color={PURPLE} />
      <Packet x1={1120} y1={420} x2={1380} y2={250} progress={t > 0.18 && t < 0.48 ? (t - 0.18) / 0.3 : t >= 0.48 && t < 0.55 ? 1 : 0} color={PURPLE} />
      <Packet x1={1120} y1={540} x2={1380} y2={540} progress={t > 0.22 && t < 0.52 ? (t - 0.22) / 0.3 : t >= 0.52 && t < 0.58 ? 1 : 0} color={PURPLE} />
      <Packet x1={1120} y1={660} x2={1380} y2={830} progress={t > 0.26 && t < 0.56 ? (t - 0.26) / 0.3 : t >= 0.56 && t < 0.62 ? 1 : 0} color={PURPLE} />
      <Packet x1={1380} y1={250} x2={1120} y2={420} progress={t > 0.55 && t < 0.82 ? (t - 0.55) / 0.27 : 0} color={PURPLE} />
      <Packet x1={1380} y1={540} x2={1120} y2={540} progress={t > 0.58 && t < 0.85 ? (t - 0.58) / 0.27 : 0} color={PURPLE} />
      <Packet x1={1380} y1={830} x2={1120} y2={660} progress={t > 0.61 && t < 0.88 ? (t - 0.61) / 0.27 : 0} color={PURPLE} />
      <Packet x1={720} y1={540} x2={430} y2={540} progress={t > 0.78 ? (t - 0.78) / 0.22 : 0} color={PURPLE} />
    </AbsoluteFill>
  );
};

const SceneKeys: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const keys = [
    {n: '01', t: 'Domain URL', s: 'https://fleet.ginfo.cc'},
    {n: '02', t: 'Hub token', s: 'flt_… from Settings'},
    {n: '03', t: 'Agent on each PC', s: 'Windows / Linux / macOS'},
    {n: '04', t: 'Import the tool', s: 'Cursor · Claude · MCP'},
  ];
  return (
    <AbsoluteFill
      style={{
        fontFamily: FONT,
        opacity: fadeInOut(frame, 150, 12),
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <div style={{fontSize: 44, fontWeight: 900, color: TEXT, marginBottom: 40, fontFamily: FONT_TITLE}}>
        Four values. Then every machine is reachable.
      </div>
      <div style={{display: 'flex', gap: 20}}>
        {keys.map((st, i) => {
          const s = spring({frame: frame - i * 10, fps, config: {damping: 13}});
          return (
            <div
              key={st.n}
              style={{
                width: 400,
                height: 260,
                opacity: s,
                transform: `translateY(${(1 - s) * 22}px)`,
                borderRadius: 22,
                background: PANEL,
                border: `1px solid ${HAIR}`,
                padding: 26,
              }}
            >
              <div style={{color: MINT, fontSize: 20, fontWeight: 800}}>{st.n}</div>
              <div style={{color: TEXT, fontSize: 30, fontWeight: 800, marginTop: 16, fontFamily: FONT_TITLE}}>{st.t}</div>
              <div style={{color: MUTED, fontSize: 20, marginTop: 12}}>{st.s}</div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

const SceneCloud: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const left = spring({frame, fps, config: {damping: 14}});
  const right = spring({frame: frame - 12, fps, config: {damping: 14}});
  return (
    <AbsoluteFill style={{opacity: fadeInOut(frame, 150, 12), fontFamily: FONT, justifyContent: 'center', alignItems: 'center'}}>
      <div style={{fontSize: 42, fontWeight: 900, color: TEXT, marginBottom: 48, fontFamily: FONT_TITLE}}>
        Local deploy cannot run a fleet. Cloud is the product.
      </div>
      <div style={{display: 'flex', gap: 36}}>
        <div
          style={{
            width: 700,
            height: 360,
            opacity: left,
            transform: `translateX(${(1 - left) * -30}px)`,
            borderRadius: 24,
            border: `1px solid ${HAIR}`,
            padding: 36,
            background: PANEL,
          }}
        >
          <div style={{color: MUTED, fontSize: 22, fontWeight: 800, letterSpacing: 2}}>LOCAL  npm run dev</div>
          <div style={{color: TEXT, fontSize: 40, fontWeight: 800, marginTop: 20, fontFamily: FONT_TITLE}}>At most a CLI</div>
          <div style={{color: MUTED, fontSize: 24, marginTop: 16, lineHeight: 1.4}}>
            127.0.0.1 only. Other OS cannot join. No “from anywhere.” Local hub never becomes the product.
          </div>
        </div>
        <div
          style={{
            width: 700,
            height: 360,
            opacity: right,
            transform: `translateX(${(1 - right) * 30}px)`,
            borderRadius: 24,
            border: `1.5px solid ${TEXT}`,
            padding: 36,
            background: LIFT,
          }}
        >
          <div style={{color: MINT, fontSize: 22, fontWeight: 800, letterSpacing: 2}}>CLOUD  fleet.ginfo.cc</div>
          <div style={{color: TEXT, fontSize: 40, fontWeight: 800, marginTop: 20, fontFamily: FONT_TITLE}}>This is where it works</div>
          <div style={{color: MUTED, fontSize: 24, marginTop: 16, lineHeight: 1.4}}>
            Deploy the hub in the cloud. Agents on Windows, Linux, and macOS dial out. One tool reaches every PC.
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

const SceneCta: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const s = spring({frame, fps, config: {damping: 16}});
  return (
    <AbsoluteFill
      style={{
        justifyContent: 'center',
        alignItems: 'center',
        fontFamily: FONT,
        opacity: fadeInOut(frame, 150, 14),
      }}
    >
      <div style={{opacity: s, transform: `scale(${0.92 + s * 0.08})`, textAlign: 'center'}}>
        <div style={{fontSize: 28, letterSpacing: 6, color: MUTED, fontWeight: 700, marginBottom: 18}}>TRY IT FIRST</div>
        <div style={{fontSize: 72, fontWeight: 900, color: TEXT, fontFamily: FONT_TITLE}}>fleet.ginfo.cc</div>
        <div style={{marginTop: 28, fontSize: 32, color: MUTED}}>
          Log in · mint a token · install Agent · import the tool
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const Architecture: React.FC = () => {
  return (
    <AbsoluteFill style={{background: BG}}>
      <Background />
      <Sequence from={0} durationInFrames={90}>
        <SceneTitle />
      </Sequence>
      <Sequence from={90} durationInFrames={180}>
        <SceneFan />
      </Sequence>
      <Sequence from={270} durationInFrames={180}>
        <ScenePackets />
      </Sequence>
      <Sequence from={450} durationInFrames={150}>
        <SceneKeys />
      </Sequence>
      <Sequence from={600} durationInFrames={150}>
        <SceneCloud />
      </Sequence>
      <Sequence from={750} durationInFrames={150}>
        <SceneCta />
      </Sequence>
    </AbsoluteFill>
  );
};

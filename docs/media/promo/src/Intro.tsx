import React from 'react';
import {
  AbsoluteFill,
  Easing,
  Img,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {COPY, type Copy, type Locale} from './copy';
import {AMBER, BLUE, FONT, MINT, MUTED, ROSE, TEXT, fadeInOut} from './theme';

export const INTRO_FPS = 30;
export const DEFAULT_SCENE_FRAMES = [360, 300, 600, 390, 390, 210];
export const INTRO_DURATION = DEFAULT_SCENE_FRAMES.reduce((a, b) => a + b, 0);

export type IntroProps = {
  locale: Locale;
  sceneFrames: number[];
};

const clamp = {extrapolateLeft: 'clamp' as const, extrapolateRight: 'clamp' as const};

const Background: React.FC = () => {
  const frame = useCurrentFrame();
  const shift = Math.sin(frame / 90) * 8;
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(110% 90% at ${48 + shift}% -8%, #16324a 0%, #070b14 44%, #05070c 100%)`,
      }}
    >
      <svg width="1920" height="1080" style={{position: 'absolute', inset: 0, opacity: 0.16}}>
        {Array.from({length: 16}).map((_, i) => (
          <line key={`v${i}`} x1={120 * i} y1={0} x2={120 * i} y2={1080} stroke="#6ea8ff" strokeWidth="1" />
        ))}
        {Array.from({length: 10}).map((_, i) => (
          <line key={`h${i}`} x1={0} y1={108 * i} x2={1920} y2={108 * i} stroke="#6ea8ff" strokeWidth="1" />
        ))}
      </svg>
    </AbsoluteFill>
  );
};

const Brand: React.FC = () => (
  <div
    style={{
      position: 'absolute',
      top: 36,
      left: 48,
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      fontFamily: FONT,
    }}
  >
    <Img src={staticFile('logo.png')} style={{width: 48, height: 48, borderRadius: 12}} />
    <div style={{letterSpacing: 4, fontSize: 22, fontWeight: 800, color: MINT}}>FLEET</div>
  </div>
);

const Caption: React.FC<{children: React.ReactNode}> = ({children}) => (
  <div
    style={{
      position: 'absolute',
      bottom: 48,
      width: '100%',
      textAlign: 'center',
      fontFamily: FONT,
      fontSize: 28,
      fontWeight: 700,
      color: MUTED,
      letterSpacing: 1,
    }}
  >
    {children}
  </div>
);

const Machine: React.FC<{
  x: number;
  y: number;
  color: string;
  place: string;
  os: string;
  status: string;
  delay: number;
  dead?: boolean;
}> = ({x, y, color, place, os, status, delay, dead}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const s = spring({frame: frame - delay, fps, config: {damping: 14, mass: 0.8}});
  const stroke = dead ? '#5a6578' : color;
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: 420,
        height: 210,
        opacity: s,
        transform: `translateY(${(1 - s) * 28}px)`,
        borderRadius: 22,
        border: `2px solid ${stroke}`,
        background: dead ? '#10141c' : `linear-gradient(165deg, ${color}33, #101826f2)`,
        padding: 28,
        fontFamily: FONT,
        filter: dead ? 'grayscale(0.7)' : 'none',
      }}
    >
      <div style={{color: dead ? MUTED : color, fontSize: 18, fontWeight: 700, letterSpacing: 2}}>{place}</div>
      <div style={{color: TEXT, fontSize: 36, fontWeight: 800, marginTop: 8}}>{os}</div>
      <div style={{color: dead ? ROSE : MINT, fontSize: 20, marginTop: 14, fontWeight: 700}}>{status}</div>
    </div>
  );
};

const ScenePain: React.FC<{t: Copy; duration: number}> = ({t, duration}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const dead = frame > 150;
  const spin = (frame % 40) / 40;
  const stamp = spring({frame: frame - 170, fps, config: {damping: 12}});
  return (
    <AbsoluteFill style={{opacity: fadeInOut(frame, duration, 14), fontFamily: FONT}}>
      <Brand />
      <div
        style={{
          position: 'absolute',
          top: 120,
          width: '100%',
          textAlign: 'center',
          color: TEXT,
          fontSize: 46,
          fontWeight: 900,
        }}
      >
        {t.painTitle}
      </div>
      <Machine x={120} y={250} color={BLUE} place={t.home} os="Windows" status={dead ? t.offline : t.online} delay={6} dead={dead} />
      <Machine x={750} y={250} color={MINT} place={t.office} os="macOS" status={dead ? t.offline : t.online} delay={16} dead={dead} />
      <Machine x={1380} y={250} color={ROSE} place={t.colo} os="Linux" status={dead ? t.offline : t.online} delay={26} dead={dead} />
      <div
        style={{
          position: 'absolute',
          left: 560,
          top: 500,
          width: 800,
          height: 220,
          borderRadius: 20,
          border: `2px solid ${dead ? ROSE : AMBER}`,
          background: '#0c1220',
          padding: 28,
          opacity: interpolate(frame, [40, 70], [0, 1], clamp),
        }}
      >
        <div style={{color: MUTED, fontSize: 18, fontWeight: 700, letterSpacing: 2}}>{t.official}</div>
        <div style={{color: TEXT, fontSize: 32, fontWeight: 800, marginTop: 16}}>
          {dead ? t.disconnected : t.connecting}
        </div>
        {!dead && (
          <div
            style={{
              marginTop: 22,
              width: 28,
              height: 28,
              borderRadius: 99,
              border: `3px solid ${AMBER}55`,
              borderTopColor: AMBER,
              transform: `rotate(${spin * 360}deg)`,
            }}
          />
        )}
      </div>
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 70,
          textAlign: 'center',
          opacity: stamp,
          transform: `scale(${0.86 + stamp * 0.14})`,
          color: ROSE,
          fontSize: 44,
          fontWeight: 900,
          letterSpacing: 4,
        }}
      >
        {t.stamp}
      </div>
    </AbsoluteFill>
  );
};

const SceneProduct: React.FC<{t: Copy; duration: number}> = ({t, duration}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const logo = spring({frame, fps, config: {damping: 14}});
  const title = spring({frame: frame - 12, fps, config: {damping: 14}});
  const pulse = interpolate(frame, [90, 140, 190], [0.4, 1, 0.7], clamp);
  const colors = [BLUE, MINT, ROSE];
  return (
    <AbsoluteFill
      style={{
        opacity: fadeInOut(frame, duration, 14),
        fontFamily: FONT,
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <Brand />
      <div style={{opacity: logo, transform: `scale(${0.9 + logo * 0.1})`, textAlign: 'center'}}>
        <Img src={staticFile('logo-512.png')} style={{width: 180, height: 180, borderRadius: 40}} />
      </div>
      <div
        style={{
          marginTop: 28,
          opacity: title,
          transform: `translateY(${(1 - title) * 24}px)`,
          color: TEXT,
          fontSize: 64,
          fontWeight: 900,
          textAlign: 'center',
          lineHeight: 1.2,
        }}
      >
        {t.productTitle}
      </div>
      <div
        style={{
          marginTop: 36,
          display: 'flex',
          gap: 24,
          opacity: interpolate(frame, [70, 110], [0, 1], clamp),
        }}
      >
        {t.machines.map((m, i) => (
          <div
            key={m.cmd}
            style={{
              width: 420,
              borderRadius: 18,
              border: `2px solid ${colors[i]}`,
              background: `${colors[i]}22`,
              padding: 22,
              boxShadow: `0 0 ${18 * pulse}px ${colors[i]}55`,
            }}
          >
            <div style={{color: colors[i], fontSize: 18, fontWeight: 800}}>{m.cmd}</div>
            <div style={{color: TEXT, fontSize: 26, fontWeight: 700, marginTop: 8}}>run hostname</div>
            <div style={{color: MINT, fontSize: 18, marginTop: 8}}>{t.sameCmd}</div>
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

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
        transform: `translateY(${(1 - s) * 22}px) scale(${0.94 + s * 0.06})`,
        borderRadius: 22,
        border: `2px solid ${color}`,
        background: `linear-gradient(165deg, ${color}40, #152033f2)`,
        boxShadow: `0 16px 44px ${color}33`,
        padding: 22,
        fontFamily: FONT,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 6,
      }}
    >
      <div style={{color, fontSize: 16, fontWeight: 700, letterSpacing: 2}}>{kicker}</div>
      <div style={{color: TEXT, fontSize: 30, fontWeight: 800, lineHeight: 1.2}}>{title}</div>
      <div style={{color: MUTED, fontSize: 18, fontWeight: 500}}>{sub}</div>
    </div>
  );
};

const Packet: React.FC<{x1: number; y1: number; x2: number; y2: number; progress: number; color: string}> = ({
  x1,
  y1,
  x2,
  y2,
  progress,
  color,
}) => {
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

const FanLines: React.FC<{grow: number}> = ({grow}) => (
  <svg width="1920" height="1080" style={{position: 'absolute', inset: 0}}>
    <path d="M 430 540 H 700" stroke={AMBER} strokeWidth="5" pathLength={1} strokeDasharray={`${grow} ${1 - grow}`} fill="none" />
    <path d="M 1120 420 L 1380 250" stroke={BLUE} strokeWidth="4" pathLength={1} strokeDasharray={`${grow} ${1 - grow}`} fill="none" />
    <path d="M 1120 540 H 1380" stroke={MINT} strokeWidth="4" pathLength={1} strokeDasharray={`${grow} ${1 - grow}`} fill="none" />
    <path d="M 1120 660 L 1380 830" stroke={ROSE} strokeWidth="4" pathLength={1} strokeDasharray={`${grow} ${1 - grow}`} fill="none" />
  </svg>
);

const ScenePrinciple: React.FC<{t: Copy; duration: number}> = ({t, duration}) => {
  const frame = useCurrentFrame();
  const grow = interpolate(frame, [12, 55], [0, 1], {...clamp, easing: Easing.out(Easing.cubic)});
  const cycle = ((frame - 70) % 90) / 90;
  const moving = frame > 70;
  return (
    <AbsoluteFill style={{opacity: fadeInOut(frame, duration, 14), fontFamily: FONT}}>
      <Brand />
      <div style={{position: 'absolute', top: 88, width: '100%', textAlign: 'center', color: TEXT, fontSize: 40, fontWeight: 800}}>
        {t.principleTitle}
      </div>
      <FanLines grow={grow} />
      <NodeCard x={80} y={390} w={350} h={300} color={AMBER} delay={4} kicker={t.toolKicker} title={t.toolTitle} sub={t.toolSub} />
      <NodeCard x={720} y={360} w={400} h={360} color={MINT} delay={16} kicker={t.hubKicker} title={t.hubTitle} sub={t.hubSub} />
      <NodeCard x={1380} y={150} w={460} h={180} color={BLUE} delay={28} kicker="WINDOWS" title="amd64 / arm64" sub={t.winSub} />
      <NodeCard x={1380} y={400} w={460} h={180} color={MINT} delay={36} kicker="LINUX" title="amd64 / arm64" sub={t.linuxSub} />
      <NodeCard x={1380} y={650} w={460} h={180} color={ROSE} delay={44} kicker="MACOS" title="arm64 / amd64" sub={t.macSub} />
      {moving && (
        <>
          <Packet x1={430} y1={540} x2={720} y2={540} progress={cycle < 0.28 ? cycle / 0.28 : 1} color={AMBER} />
          <Packet x1={1120} y1={420} x2={1380} y2={250} progress={cycle > 0.18 && cycle < 0.48 ? (cycle - 0.18) / 0.3 : cycle >= 0.48 && cycle < 0.55 ? 1 : 0} color={BLUE} />
          <Packet x1={1120} y1={540} x2={1380} y2={540} progress={cycle > 0.22 && cycle < 0.52 ? (cycle - 0.22) / 0.3 : cycle >= 0.52 && cycle < 0.58 ? 1 : 0} color={MINT} />
          <Packet x1={1120} y1={660} x2={1380} y2={830} progress={cycle > 0.26 && cycle < 0.56 ? (cycle - 0.26) / 0.3 : cycle >= 0.56 && cycle < 0.62 ? 1 : 0} color={ROSE} />
          <Packet x1={1380} y1={250} x2={1120} y2={420} progress={cycle > 0.55 && cycle < 0.82 ? (cycle - 0.55) / 0.27 : 0} color={BLUE} />
          <Packet x1={1380} y1={540} x2={1120} y2={540} progress={cycle > 0.58 && cycle < 0.85 ? (cycle - 0.58) / 0.27 : 0} color={MINT} />
          <Packet x1={1380} y1={830} x2={1120} y2={660} progress={cycle > 0.61 && cycle < 0.88 ? (cycle - 0.61) / 0.27 : 0} color={ROSE} />
          <Packet x1={720} y1={540} x2={430} y2={540} progress={cycle > 0.78 ? (cycle - 0.78) / 0.22 : 0} color={AMBER} />
        </>
      )}
      <Caption>{t.principleCaption}</Caption>
    </AbsoluteFill>
  );
};

const SceneCollab: React.FC<{t: Copy; duration: number}> = ({t, duration}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const client = frame < 210 ? 'Cursor' : 'Claude';
  const swap = spring({frame: frame - 210, fps, config: {damping: 14}});
  const list = interpolate(frame, [30, 70], [0, 1], clamp);
  const run = interpolate(frame, [90, 130], [0, 1], clamp);
  return (
    <AbsoluteFill style={{opacity: fadeInOut(frame, duration, 14), fontFamily: FONT}}>
      <Brand />
      <div style={{position: 'absolute', top: 100, width: '100%', textAlign: 'center', color: TEXT, fontSize: 40, fontWeight: 800}}>
        {t.collabTitle}
      </div>
      <div
        style={{
          position: 'absolute',
          left: 120,
          top: 200,
          width: 820,
          height: 620,
          borderRadius: 24,
          border: `2px solid ${AMBER}88`,
          background: '#0c1220',
          padding: 32,
          opacity: spring({frame, fps, config: {damping: 16}}),
        }}
      >
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
          <div style={{color: AMBER, fontSize: 22, fontWeight: 800, letterSpacing: 2}}>
            {client}
            {frame >= 210 ? t.sameCreds : ''}
          </div>
          <div style={{color: MINT, fontSize: 18, opacity: frame >= 210 ? swap : 1}}>{t.mcpImported}</div>
        </div>
        <div style={{marginTop: 28, color: MUTED, fontSize: 22}}>&gt; list</div>
        <div style={{marginTop: 16, opacity: list, color: TEXT, fontSize: 26, lineHeight: 1.7, fontWeight: 600}}>
          {t.home}-Win　　{t.online}
          <br />
          {t.office}-Mac　　{t.online}
          <br />
          {t.colo}-Linux　{t.online}
        </div>
        <div style={{marginTop: 28, opacity: run, color: MUTED, fontSize: 22}}>&gt; run hostname　·　{t.home}-Win</div>
        <div style={{marginTop: 12, opacity: run, color: MINT, fontSize: 32, fontWeight: 800}}>MySuperPC</div>
      </div>
      <div
        style={{
          position: 'absolute',
          right: 120,
          top: 200,
          width: 780,
          height: 620,
          display: 'flex',
          flexDirection: 'column',
          gap: 22,
        }}
      >
        <div
          style={{
            flex: 1,
            borderRadius: 22,
            border: '2px solid #5a6578',
            background: '#10141c',
            padding: 32,
            opacity: interpolate(frame, [40, 80], [0, 1], clamp),
          }}
        >
          <div style={{color: ROSE, fontSize: 20, fontWeight: 800, letterSpacing: 2}}>{t.officialCh}</div>
          <div style={{color: TEXT, fontSize: 36, fontWeight: 800, marginTop: 18}}>{t.officialDown}</div>
          <div style={{color: MUTED, fontSize: 22, marginTop: 12}}>{t.officialSub}</div>
        </div>
        <div
          style={{
            flex: 1,
            borderRadius: 22,
            border: `2px solid ${MINT}`,
            background: `${MINT}18`,
            padding: 32,
            opacity: interpolate(frame, [70, 110], [0, 1], clamp),
          }}
        >
          <div style={{color: MINT, fontSize: 20, fontWeight: 800, letterSpacing: 2}}>FLEET</div>
          <div style={{color: TEXT, fontSize: 36, fontWeight: 800, marginTop: 18}}>{t.fleetOn}</div>
          <div style={{color: MUTED, fontSize: 22, marginTop: 12}}>{t.fleetSub}</div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

const SceneSetup: React.FC<{t: Copy; duration: number}> = ({t, duration}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const keys = [
    {n: '01', title: t.key1t, sub: t.key1s},
    {n: '02', title: t.key2t, sub: t.key2s},
    {n: '03', title: t.key3t, sub: t.key3s},
    {n: '04', title: t.key4t, sub: t.key4s},
  ];
  const showCloud = frame > 200;
  return (
    <AbsoluteFill
      style={{
        fontFamily: FONT,
        opacity: fadeInOut(frame, duration, 14),
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <Brand />
      {!showCloud ? (
        <>
          <div style={{fontSize: 44, fontWeight: 900, color: TEXT, marginBottom: 40}}>{t.setupTitle}</div>
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
                    background: '#101826',
                    border: `1px solid ${MINT}55`,
                    padding: 26,
                  }}
                >
                  <div style={{color: MINT, fontSize: 20, fontWeight: 800}}>{st.n}</div>
                  <div style={{color: TEXT, fontSize: 28, fontWeight: 800, marginTop: 16}}>{st.title}</div>
                  <div style={{color: MUTED, fontSize: 20, marginTop: 12}}>{st.sub}</div>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <>
          <div style={{fontSize: 42, fontWeight: 900, color: TEXT, marginBottom: 40}}>{t.cloudTitle}</div>
          <div style={{display: 'flex', gap: 36}}>
            <div
              style={{
                width: 700,
                height: 340,
                borderRadius: 24,
                border: '2px solid #3a4558',
                padding: 36,
                background: '#0c1220',
                opacity: spring({frame: frame - 200, fps, config: {damping: 14}}),
              }}
            >
              <div style={{color: MUTED, fontSize: 22, fontWeight: 800, letterSpacing: 2}}>{t.localKicker}</div>
              <div style={{color: TEXT, fontSize: 40, fontWeight: 800, marginTop: 20}}>{t.localTitle}</div>
              <div style={{color: MUTED, fontSize: 24, marginTop: 16, lineHeight: 1.45}}>{t.localBody}</div>
            </div>
            <div
              style={{
                width: 700,
                height: 340,
                borderRadius: 24,
                border: `2px solid ${MINT}`,
                padding: 36,
                background: `${MINT}14`,
                opacity: spring({frame: frame - 214, fps, config: {damping: 14}}),
              }}
            >
              <div style={{color: MINT, fontSize: 22, fontWeight: 800, letterSpacing: 2}}>{t.cloudKicker}</div>
              <div style={{color: TEXT, fontSize: 40, fontWeight: 800, marginTop: 20}}>{t.cloudHead}</div>
              <div style={{color: MUTED, fontSize: 24, marginTop: 16, lineHeight: 1.45}}>{t.cloudBody}</div>
            </div>
          </div>
        </>
      )}
    </AbsoluteFill>
  );
};

const SceneCta: React.FC<{t: Copy; duration: number}> = ({t, duration}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const s = spring({frame, fps, config: {damping: 16}});
  return (
    <AbsoluteFill
      style={{
        justifyContent: 'center',
        alignItems: 'center',
        fontFamily: FONT,
        opacity: fadeInOut(frame, duration, 16),
      }}
    >
      <div style={{opacity: s, transform: `scale(${0.92 + s * 0.08})`, textAlign: 'center'}}>
        <Img src={staticFile('logo-512.png')} style={{width: 140, height: 140, borderRadius: 32, marginBottom: 22}} />
        <div style={{fontSize: 26, letterSpacing: 6, color: MINT, fontWeight: 700, marginBottom: 16}}>{t.ctaKicker}</div>
        <div style={{fontSize: 86, fontWeight: 900, color: TEXT}}>{t.ctaUrl}</div>
        <div style={{marginTop: 28, fontSize: 30, color: MUTED}}>{t.ctaSteps}</div>
        <div style={{marginTop: 18, fontSize: 28, color: TEXT, fontWeight: 700}}>{t.ctaLine}</div>
      </div>
    </AbsoluteFill>
  );
};

export const Intro: React.FC<IntroProps> = ({locale, sceneFrames}) => {
  const t = COPY[locale];
  const frames = sceneFrames?.length === 6 ? sceneFrames : DEFAULT_SCENE_FRAMES;
  const starts = frames.reduce<number[]>((acc, d) => {
    acc.push((acc.length ? acc[acc.length - 1] : 0) + (acc.length ? frames[acc.length - 1] : 0));
    return acc;
  }, []);
  const scenes = [
    <ScenePain t={t} duration={frames[0]} />,
    <SceneProduct t={t} duration={frames[1]} />,
    <ScenePrinciple t={t} duration={frames[2]} />,
    <SceneCollab t={t} duration={frames[3]} />,
    <SceneSetup t={t} duration={frames[4]} />,
    <SceneCta t={t} duration={frames[5]} />,
  ];
  return (
    <AbsoluteFill style={{background: '#070b14'}}>
      <Background />
      {scenes.map((node, i) => (
        <Sequence key={i} from={starts[i]} durationInFrames={frames[i]}>
          {node}
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

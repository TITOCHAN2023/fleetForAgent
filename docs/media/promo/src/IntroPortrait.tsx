import React from 'react';
import {
  AbsoluteFill,
  Img,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {COPY, type Copy} from './copy';
import {AMBER, BG, BLUE, DEAD, DEAD_BG, FONT, FONT_TITLE, HAIR, LIFT, MINT, MUTED, OpenBg, PANEL, PURPLE, ROSE, TEXT, fadeInOut} from './theme';
import {DEFAULT_SCENE_FRAMES, type IntroProps} from './Intro';

const clamp = {extrapolateLeft: 'clamp' as const, extrapolateRight: 'clamp' as const};
const W = 1080;

const Background: React.FC = () => {
  const frame = useCurrentFrame();
  const {width, height} = useVideoConfig();
  return <OpenBg width={width} height={height} frame={frame} />;
};

const Brand: React.FC = () => (
  <div
    style={{
      position: 'absolute',
      top: 88,
      left: 40,
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      fontFamily: FONT,
    }}
  >
    <Img src={staticFile('logo.png')} style={{width: 44, height: 44, borderRadius: 12}} />
    <div style={{letterSpacing: 4, fontSize: 20, fontWeight: 800, color: TEXT, fontFamily: FONT_TITLE}}>FLEET</div>
  </div>
);

const Card: React.FC<{
  y: number;
  color: string;
  kicker: string;
  title: string;
  sub: string;
  delay: number;
  h?: number;
  dead?: boolean;
}> = ({y, color, kicker, title, sub, delay, h = 168, dead}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const s = spring({frame: frame - delay, fps, config: {damping: 14, mass: 0.8}});
  const stroke = dead ? DEAD : HAIR;
  return (
    <div
      style={{
        position: 'absolute',
        left: 48,
        top: y,
        width: W - 96,
        height: h,
        opacity: s,
        transform: `translateY(${(1 - s) * 22}px)`,
        borderRadius: 22,
        border: `1px solid ${stroke}`,
        background: dead ? DEAD_BG : PANEL,
        padding: '22px 26px',
        fontFamily: FONT,
        filter: dead ? 'grayscale(0.7)' : 'none',
      }}
    >
      <div style={{color: dead ? MUTED : color, fontSize: 16, fontWeight: 700, letterSpacing: 2}}>{kicker}</div>
      <div style={{color: TEXT, fontSize: 34, fontWeight: 800, marginTop: 8, lineHeight: 1.15, fontFamily: FONT_TITLE}}>{title}</div>
      <div style={{color: dead ? MUTED : TEXT, fontSize: 20, marginTop: 10, fontWeight: 600}}>{sub}</div>
    </div>
  );
};

const ScenePain: React.FC<{t: Copy; duration: number}> = ({t, duration}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const spin = (frame % 40) / 40;
  const stamp = spring({frame: frame - 120, fps, config: {damping: 12}});
  return (
    <AbsoluteFill style={{opacity: fadeInOut(frame, duration, 14), fontFamily: FONT}}>
      <Brand />
      <div
        style={{
          position: 'absolute',
          top: 150,
          width: '100%',
          textAlign: 'center',
          color: TEXT,
          fontSize: 42,
          fontWeight: 900,
          padding: '0 36px',
          lineHeight: 1.25,
          fontFamily: FONT_TITLE,
        }}
      >
        {t.painTitle}
      </div>
      <div
        style={{
          position: 'absolute',
          left: 48,
          top: 260,
          width: W - 96,
          height: 280,
          borderRadius: 24,
          border: `1px solid ${HAIR}`,
          background: PANEL,
          padding: 26,
          opacity: interpolate(frame, [6, 28], [0, 1], clamp),
        }}
      >
        <div style={{color: AMBER, fontSize: 16, fontWeight: 800, letterSpacing: 3}}>{t.official}</div>
        <div style={{color: TEXT, fontSize: 26, fontWeight: 800, marginTop: 8, fontFamily: FONT_TITLE}}>{t.loopNames}</div>
        <div style={{color: AMBER, fontSize: 22, fontWeight: 700, marginTop: 14}}>{t.connecting}</div>
        <div
          style={{
            marginTop: 20,
            width: 28,
            height: 28,
            borderRadius: 99,
            border: `3px solid ${PURPLE}44`,
            borderTopColor: PURPLE,
            transform: `rotate(${spin * 360}deg)`,
          }}
        />
      </div>
      <Card y={570} color={BLUE} kicker={t.home} title="Windows" sub={t.offline} delay={18} dead />
      <Card y={758} color={MINT} kicker={t.office} title="macOS" sub={t.offline} delay={28} dead />
      <Card y={946} color={ROSE} kicker={t.colo} title="Linux" sub={t.offline} delay={38} dead />
      <div
        style={{
          position: 'absolute',
          left: 40,
          right: 40,
          top: 1160,
          textAlign: 'center',
          opacity: stamp,
          transform: `scale(${0.9 + stamp * 0.1})`,
          color: TEXT,
          fontSize: 38,
          fontWeight: 900,
          letterSpacing: 2,
          fontFamily: FONT_TITLE,
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
    <AbsoluteFill style={{opacity: fadeInOut(frame, duration, 14), fontFamily: FONT}}>
      <Brand />
      <div
        style={{
          position: 'absolute',
          top: 200,
          width: '100%',
          textAlign: 'center',
          opacity: logo,
          transform: `scale(${0.92 + logo * 0.08})`,
        }}
      >
        <Img src={staticFile('logo-512.png')} style={{width: 160, height: 160, borderRadius: 36}} />
      </div>
      <div
        style={{
          position: 'absolute',
          top: 390,
          width: '100%',
          padding: '0 48px',
          opacity: title,
          color: TEXT,
          fontSize: 48,
          fontWeight: 900,
          textAlign: 'center',
          lineHeight: 1.25,
          fontFamily: FONT_TITLE,
        }}
      >
        {t.productTitle}
      </div>
      {t.machines.map((m, i) => (
        <div
          key={m.cmd}
          style={{
            position: 'absolute',
            left: 48,
            top: 620 + i * 200,
            width: W - 96,
            borderRadius: 20,
            border: `1px solid ${HAIR}`,
            background: PANEL,
            padding: 24,
            opacity: interpolate(frame, [36 + i * 8, 70 + i * 8], [0, 1], clamp),
            boxShadow: `0 0 ${12 * pulse}px rgba(139,92,255,0.18)`,
          }}
        >
          <div style={{color: colors[i], fontSize: 18, fontWeight: 800, fontFamily: FONT_TITLE}}>{m.cmd}</div>
          <div style={{color: TEXT, fontSize: 28, fontWeight: 700, marginTop: 8}}>run hostname</div>
          <div style={{color: MUTED, fontSize: 18, marginTop: 8}}>{t.sameCmd}</div>
        </div>
      ))}
    </AbsoluteFill>
  );
};

const ScenePrinciple: React.FC<{t: Copy; duration: number}> = ({t, duration}) => {
  const frame = useCurrentFrame();
  const grow = interpolate(frame, [12, 50], [0, 1], clamp);
  const cycle = ((frame - 70) % 90) / 90;
  const moving = frame > 70;
  const cx = W / 2;
  return (
    <AbsoluteFill style={{opacity: fadeInOut(frame, duration, 14), fontFamily: FONT}}>
      <Brand />
      <div
        style={{
          position: 'absolute',
          top: 160,
          width: '100%',
          textAlign: 'center',
          color: TEXT,
          fontSize: 34,
          fontWeight: 800,
          padding: '0 36px',
          lineHeight: 1.3,
          fontFamily: FONT_TITLE,
        }}
      >
        {t.principleTitle}
      </div>
      <svg width={W} height={1920} style={{position: 'absolute', inset: 0}}>
        <path
          d={`M ${cx} 430 V 520`}
          stroke={AMBER}
          strokeWidth="5"
          pathLength={1}
          strokeDasharray={`${grow} ${1 - grow}`}
          fill="none"
        />
        <path
          d={`M ${cx} 720 V 800`}
          stroke={MINT}
          strokeWidth="5"
          pathLength={1}
          strokeDasharray={`${grow} ${1 - grow}`}
          fill="none"
        />
      </svg>
      <Card y={250} color={AMBER} kicker={t.toolKicker} title={t.toolTitle} sub={t.toolSub} delay={4} h={170} />
      <Card y={530} color={MINT} kicker={t.hubKicker} title={t.hubTitle} sub={t.hubSub} delay={16} h={180} />
      <Card y={820} color={BLUE} kicker="WINDOWS" title="amd64 / arm64" sub={t.winSub} delay={28} h={150} />
      <Card y={990} color={MINT} kicker="LINUX" title="amd64 / arm64" sub={t.linuxSub} delay={36} h={150} />
      <Card y={1160} color={ROSE} kicker="MACOS" title="arm64 / amd64" sub={t.macSub} delay={44} h={150} />
      {moving && (
        <>
          {[
            {y1: 430, y2: 530, color: PURPLE, a: 0, b: 0.28},
            {y1: 720, y2: 820, color: PURPLE, a: 0.2, b: 0.5},
            {y1: 970, y2: 1160, color: PURPLE, a: 0.28, b: 0.58},
          ].map((p, i) => {
            const active = cycle > p.a && cycle < p.b;
            const pr = active ? (cycle - p.a) / (p.b - p.a) : 0;
            if (pr <= 0 || pr >= 1) return null;
            return (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  left: cx - 8,
                  top: p.y1 + (p.y2 - p.y1) * pr - 8,
                  width: 16,
                  height: 16,
                  borderRadius: 99,
                  background: p.color,
                  boxShadow: `0 0 16px ${p.color}`,
                }}
              />
            );
          })}
        </>
      )}
      <div
        style={{
          position: 'absolute',
          bottom: 220,
          width: '100%',
          textAlign: 'center',
          color: MUTED,
          fontSize: 24,
          fontWeight: 700,
        }}
      >
        {t.principleCaption}
      </div>
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
      <div
        style={{
          position: 'absolute',
          top: 160,
          width: '100%',
          textAlign: 'center',
          color: TEXT,
          fontSize: 36,
          fontWeight: 800,
          padding: '0 40px',
          fontFamily: FONT_TITLE,
        }}
      >
        {t.collabTitle}
      </div>
      <div
        style={{
          position: 'absolute',
          left: 40,
          top: 240,
          width: W - 80,
          height: 620,
          borderRadius: 24,
          border: `1px solid ${HAIR}`,
          background: PANEL,
          padding: 28,
        }}
      >
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
          <div style={{color: AMBER, fontSize: 22, fontWeight: 800}}>{client}</div>
          <div style={{color: TEXT, fontSize: 16, opacity: frame >= 210 ? swap : 1}}>{t.mcpImported}</div>
        </div>
        <div style={{marginTop: 8, color: MUTED, fontSize: 16}}>{frame >= 210 ? t.sameCreds : ''}</div>
        <div style={{marginTop: 22, color: MUTED, fontSize: 22}}>&gt; list</div>
        <div style={{marginTop: 14, opacity: list, color: TEXT, fontSize: 26, lineHeight: 1.7, fontWeight: 600}}>
          {t.home}-Win　　{t.online}
          <br />
          {t.office}-Mac　　{t.online}
          <br />
          {t.colo}-Linux　{t.online}
        </div>
        <div style={{marginTop: 22, opacity: run, color: MUTED, fontSize: 20}}>&gt; run hostname　·　{t.home}-Win</div>
        <div style={{marginTop: 10, opacity: run, color: TEXT, fontSize: 32, fontWeight: 800}}>MySuperPC</div>
      </div>
      <div
        style={{
          position: 'absolute',
          left: 40,
          top: 890,
          width: W - 80,
          height: 200,
          borderRadius: 22,
          border: `1px solid ${HAIR}`,
          background: PANEL,
          padding: 26,
          opacity: interpolate(frame, [40, 80], [0, 1], clamp),
        }}
      >
        <div style={{color: MUTED, fontSize: 18, fontWeight: 800, letterSpacing: 2}}>{t.officialCh}</div>
        <div style={{color: TEXT, fontSize: 32, fontWeight: 800, marginTop: 10, fontFamily: FONT_TITLE}}>{t.officialDown}</div>
        <div style={{color: MUTED, fontSize: 20, marginTop: 8}}>{t.officialSub}</div>
      </div>
      <div
        style={{
          position: 'absolute',
          left: 40,
          top: 1118,
          width: W - 80,
          height: 200,
          borderRadius: 22,
          border: `1.5px solid ${TEXT}`,
          background: LIFT,
          padding: 26,
          opacity: interpolate(frame, [70, 110], [0, 1], clamp),
        }}
      >
        <div style={{color: TEXT, fontSize: 18, fontWeight: 800, letterSpacing: 2}}>FLEET</div>
        <div style={{color: TEXT, fontSize: 32, fontWeight: 800, marginTop: 10, fontFamily: FONT_TITLE}}>{t.fleetOn}</div>
        <div style={{color: MUTED, fontSize: 20, marginTop: 8}}>{t.fleetSub}</div>
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
    <AbsoluteFill style={{opacity: fadeInOut(frame, duration, 14), fontFamily: FONT}}>
      <Brand />
      {!showCloud ? (
        <>
          <div
            style={{
              position: 'absolute',
              top: 170,
              width: '100%',
              textAlign: 'center',
              fontSize: 36,
              fontWeight: 900,
              color: TEXT,
              padding: '0 40px',
              lineHeight: 1.3,
              fontFamily: FONT_TITLE,
            }}
          >
            {t.setupTitle}
          </div>
          {keys.map((st, i) => {
            const col = i % 2;
            const row = Math.floor(i / 2);
            const s = spring({frame: frame - i * 10, fps, config: {damping: 13}});
            return (
              <div
                key={st.n}
                style={{
                  position: 'absolute',
                  left: 40 + col * 510,
                  top: 320 + row * 280,
                  width: 490,
                  height: 250,
                  opacity: s,
                  transform: `translateY(${(1 - s) * 18}px)`,
                  borderRadius: 22,
                  background: PANEL,
                  border: `1px solid ${HAIR}`,
                  padding: 24,
                }}
              >
                <div style={{color: MUTED, fontSize: 18, fontWeight: 800}}>{st.n}</div>
                <div style={{color: TEXT, fontSize: 28, fontWeight: 800, marginTop: 14, fontFamily: FONT_TITLE}}>{st.title}</div>
                <div style={{color: MUTED, fontSize: 20, marginTop: 12, lineHeight: 1.4}}>{st.sub}</div>
              </div>
            );
          })}
        </>
      ) : (
        <>
          <div
            style={{
              position: 'absolute',
              top: 180,
              width: '100%',
              textAlign: 'center',
              fontSize: 34,
              fontWeight: 900,
              color: TEXT,
              padding: '0 40px',
              lineHeight: 1.3,
              fontFamily: FONT_TITLE,
            }}
          >
            {t.cloudTitle}
          </div>
          <div
            style={{
              position: 'absolute',
              left: 40,
              top: 340,
              width: W - 80,
              height: 360,
              borderRadius: 24,
              border: `1px solid ${HAIR}`,
              padding: 32,
              background: PANEL,
              opacity: spring({frame: frame - 200, fps, config: {damping: 14}}),
            }}
          >
            <div style={{color: MUTED, fontSize: 18, fontWeight: 800, letterSpacing: 2}}>{t.localKicker}</div>
            <div style={{color: TEXT, fontSize: 36, fontWeight: 800, marginTop: 16, fontFamily: FONT_TITLE}}>{t.localTitle}</div>
            <div style={{color: MUTED, fontSize: 22, marginTop: 14, lineHeight: 1.45}}>{t.localBody}</div>
          </div>
          <div
            style={{
              position: 'absolute',
              left: 40,
              top: 740,
              width: W - 80,
              height: 400,
              borderRadius: 24,
              border: `1.5px solid ${TEXT}`,
              padding: 32,
              background: LIFT,
              opacity: spring({frame: frame - 214, fps, config: {damping: 14}}),
            }}
          >
            <div style={{color: TEXT, fontSize: 18, fontWeight: 800, letterSpacing: 2}}>{t.cloudKicker}</div>
            <div style={{color: TEXT, fontSize: 36, fontWeight: 800, marginTop: 16, fontFamily: FONT_TITLE}}>{t.cloudHead}</div>
            <div style={{color: MUTED, fontSize: 22, marginTop: 14, lineHeight: 1.45}}>{t.cloudBody}</div>
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
        paddingBottom: 160,
      }}
    >
      <div style={{opacity: s, transform: `scale(${0.92 + s * 0.08})`, textAlign: 'center', padding: '0 32px'}}>
        <Img src={staticFile('logo-512.png')} style={{width: 160, height: 160, borderRadius: 36, marginBottom: 28}} />
        <div style={{fontSize: 24, letterSpacing: 8, color: MUTED, fontWeight: 700, marginBottom: 20}}>{t.ctaKicker}</div>
        <div style={{fontSize: 64, fontWeight: 900, color: TEXT, letterSpacing: -1, fontFamily: FONT_TITLE}}>{t.ctaUrl}</div>
        <div style={{marginTop: 32, fontSize: 26, color: MUTED, lineHeight: 1.5}}>{t.ctaSteps}</div>
        <div style={{marginTop: 22, fontSize: 30, color: TEXT, fontWeight: 700}}>{t.ctaLine}</div>
      </div>
    </AbsoluteFill>
  );
};

export const IntroPortrait: React.FC<IntroProps> = ({locale, sceneFrames}) => {
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
    <AbsoluteFill style={{background: BG}}>
      <Background />
      {scenes.map((node, i) => (
        <Sequence key={i} from={starts[i]} durationInFrames={frames[i]}>
          {node}
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

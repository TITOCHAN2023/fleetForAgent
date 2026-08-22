import React from 'react';
import {Composition} from 'remotion';
import {Architecture} from './Architecture';
import {FlowLoop} from './FlowLoop';
import {DEFAULT_SCENE_FRAMES, INTRO_DURATION, INTRO_FPS, Intro, type IntroProps} from './Intro';

const introMeta = async ({props}: {props: IntroProps}) => {
  const frames = props.sceneFrames?.length === 6 ? props.sceneFrames : DEFAULT_SCENE_FRAMES;
  return {durationInFrames: frames.reduce((a, b) => a + b, 0)};
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="IntroZH"
        component={Intro}
        durationInFrames={INTRO_DURATION}
        fps={INTRO_FPS}
        width={1920}
        height={1080}
        defaultProps={{locale: 'zh', sceneFrames: DEFAULT_SCENE_FRAMES}}
        calculateMetadata={introMeta}
      />
      <Composition
        id="IntroEN"
        component={Intro}
        durationInFrames={INTRO_DURATION}
        fps={INTRO_FPS}
        width={1920}
        height={1080}
        defaultProps={{locale: 'en', sceneFrames: DEFAULT_SCENE_FRAMES}}
        calculateMetadata={introMeta}
      />
      <Composition
        id="Architecture"
        component={Architecture}
        durationInFrames={900}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="FlowLoop"
        component={FlowLoop}
        durationInFrames={240}
        fps={30}
        width={1280}
        height={720}
      />
    </>
  );
};

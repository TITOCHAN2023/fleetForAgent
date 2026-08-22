import React from 'react';
import {Composition} from 'remotion';
import {Architecture} from './Architecture';
import {FlowLoop} from './FlowLoop';

export const RemotionRoot: React.FC = () => {
  return (
    <>
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

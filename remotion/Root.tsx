import { Composition } from "remotion";

import { LayoffQuote, layoffQuoteSchema } from "./compositions/LayoffQuote";

const FPS = 30;
const DEFAULT_DURATION_SEC = 8;

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="LayoffQuote"
        component={LayoffQuote}
        schema={layoffQuoteSchema}
        fps={FPS}
        width={1080}
        height={1920}
        // Duration is driven by props.durationSec → durationInFrames via calculateMetadata.
        calculateMetadata={({ props }) => ({
          durationInFrames: Math.max(
            1,
            Math.round((props.durationSec ?? DEFAULT_DURATION_SEC) * FPS)
          ),
        })}
        // NOTE: keep this as an inline literal — Remotion Studio's "save props
        // to source" codemod rewrites this object in place and refuses a
        // variable reference.
        defaultProps={{"quoteText":"Severance precedes existence","author":"Jean-Paul Sartre","backgroundVideo":"/assets/backgrounds/contemplation/coffee-alone-moody-35027280.mp4","backgroundCategory":"emptiness" as const,"animationStyle":"kenBurns" as const,"textInStart":0.2,"textInEnd":1.5,"authorInStart":1.8,"authorInEnd":2.5,"durationSec":6}}
      />
    </>
  );
};

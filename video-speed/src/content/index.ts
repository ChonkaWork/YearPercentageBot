import { App } from './app';

/**
 * Content script entry (every frame, see manifest.json). If an older copy is still running
 * in this frame (the extension was reloaded or updated), it is torn down first so there's
 * never two controllers or two key handlers.
 */

const INSTANCE = Symbol.for('video-speed-plus');
type Holder = { [INSTANCE]?: App };

const holder = globalThis as Holder;
holder[INSTANCE]?.destroy();
const app = new App();
holder[INSTANCE] = app;
app.start().catch((error: unknown) => {
  console.error('[Video Speed+] failed to start', error);
});

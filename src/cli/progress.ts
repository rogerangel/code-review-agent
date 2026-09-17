import type { ReviewProgressEvent } from '../core/types.js';

/** Numeric, non-blocking progress; no prompts, arguments or model reasoning. */
export function createProgressReporter(enabled: boolean, write: (line: string) => void = (line) => console.error(line)) {
  let active: Extract<ReviewProgressEvent, { type: 'call-start' }> | undefined;
  let activeAt = 0;
  const timer = enabled ? setInterval(() => {
    if (active) write(`[review] call ${active.index} ${active.phase} still running (${Math.round((Date.now() - activeAt) / 1000)}s)`);
  }, 30_000) : undefined;
  timer?.unref();
  return {
    onProgress(event: ReviewProgressEvent) {
      if (!enabled) return;
      if (event.type === 'call-start') {
        active = event; activeAt = Date.now();
        write(`[review] call ${event.index} ${event.phase}${event.batchIndex === undefined ? '' : ` batch ${event.batchIndex + 1}`} started`);
      } else if (event.type === 'call-end') {
        if (active?.index === event.metric.index) active = undefined;
        const usage = event.metric.completionTokens === undefined ? '' : `, ${event.metric.completionTokens} completion tokens`;
        write(`[review] call ${event.metric.index} ${event.metric.outcome} (${Math.round(event.metric.durationMs / 1000)}s${usage})`);
      } else if (event.type === 'file-completed') {
        write(`[review] completed ${JSON.stringify(event.file)}`);
      } else write(`[review] compacted transcript (${event.count})`);
    },
    close() { if (timer) clearInterval(timer); },
  };
}

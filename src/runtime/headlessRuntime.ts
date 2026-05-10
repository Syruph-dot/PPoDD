import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { GameRuntimeAdapter } from '../core/Game';

type HeadlessRuntimeOptions = {
  width?: number;
  height?: number;
  outputDir?: string;
  startTime?: number;
};

type ScheduledTimeout = {
  id: number;
  dueTime: number;
  callback: () => void;
};

export function createHeadlessRuntimeAdapter(options: HeadlessRuntimeOptions = {}): GameRuntimeAdapter {
  const width = Math.max(320, options.width ?? 1200);
  const height = Math.max(240, options.height ?? 800);
  const outputDir = options.outputDir ? resolve(options.outputDir) : resolve(process.cwd(), 'training-output');
  let virtualNow = options.startTime ?? Date.now();
  let nextTimeoutId = 1;
  const pendingTimeouts = new Map<number, ScheduledTimeout>();

  const flushDueTimeouts = () => {
    let guard = 0;

    while (guard < 10000) {
      const dueTimeouts = Array.from(pendingTimeouts.values())
        .filter((entry) => entry.dueTime <= virtualNow)
        .sort((left, right) => left.dueTime - right.dueTime || left.id - right.id);

      if (dueTimeouts.length === 0) {
        return;
      }

      for (const entry of dueTimeouts) {
        if (!pendingTimeouts.has(entry.id)) {
          continue;
        }

        pendingTimeouts.delete(entry.id);
        entry.callback();
      }

      guard += 1;
    }

    throw new Error('Headless runtime timer flush exceeded the safety limit.');
  };

  return {
    getDevicePixelRatio: () => 1,
    getViewportSize: () => ({ width, height }),
    now: () => Math.round(virtualNow),
    dateNow: () => Math.round(virtualNow),
    setTimeout: (callback, delayMs) => {
      const id = nextTimeoutId;
      nextTimeoutId += 1;
      pendingTimeouts.set(id, {
        id,
        dueTime: virtualNow + Math.max(0, delayMs),
        callback,
      });
      return id;
    },
    clearTimeout: (id) => {
      pendingTimeouts.delete(id);
    },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {
      // No-op in headless mode. The runner drives fixed steps explicitly.
    },
    addWindowListener: () => {
      // No-op in headless mode.
    },
    removeWindowListener: () => {
      // No-op in headless mode.
    },
    createElementNS: () => null,
    createElement: () => null,
    createObjectURL: () => null,
    revokeObjectURL: () => {
      // No-op.
    },
    advanceTime: (deltaMs) => {
      virtualNow += Math.max(0, deltaMs);
      flushDueTimeouts();
    },
    saveFile: (content, filename) => {
      const outputPath = resolve(outputDir, filename);
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, content, 'utf8');
    },
  };
}

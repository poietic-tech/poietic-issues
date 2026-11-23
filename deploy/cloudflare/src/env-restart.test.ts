import { describe, expect, it } from 'vitest';
import {
  type ContainerHandle,
  ContainerStillStopping,
  EnvGuard,
  envFingerprint,
} from './env-restart.ts';

const OLD = { POIETIC_ISSUES_ALLOWED_ORIGINS: 'https://issues.poietic.tech' };
const NEW = {
  POIETIC_ISSUES_ALLOWED_ORIGINS: 'https://issues.poietic.tech,https://newsroom.poietic.tech',
};

/** A container that takes `stopAfterPolls` sleeps to exit after SIGTERM (Litestream's final sync). */
function fakeContainer(opts: { running: boolean; started?: string; stopAfterPolls?: number }) {
  const events: string[] = [];
  let running = opts.running;
  let stored = opts.started;
  let pollsLeft = Infinity;
  const handle: ContainerHandle = {
    running: () => running,
    signalStop: async () => {
      events.push('SIGTERM');
      pollsLeft = opts.stopAfterPolls ?? 0;
      if (pollsLeft === 0) running = false;
    },
    readStartedEnv: async () => stored,
    writeStartedEnv: async (f) => {
      events.push(`record ${f.slice(0, 6)}`);
      stored = f;
    },
    sleep: async () => {
      if (--pollsLeft <= 0) running = false;
    },
  };
  return { handle, events, stored: () => stored, isRunning: () => running };
}

const quiet = { log: () => {}, pollMs: 1 };

describe('envFingerprint', () => {
  it('is stable across key order and changes with any value', async () => {
    expect(await envFingerprint({ A: '1', B: '2' })).toBe(await envFingerprint({ B: '2', A: '1' }));
    expect(await envFingerprint(OLD)).not.toBe(await envFingerprint(NEW));
    expect(await envFingerprint({ A: '1' })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('EnvGuard', () => {
  it('leaves a container started with the current env alone', async () => {
    const c = fakeContainer({ running: true, started: await envFingerprint(NEW) });
    await new EnvGuard(c.handle, NEW, quiet).ensureCurrent();
    expect(c.events).toEqual([]);
    expect(c.isRunning()).toBe(true);
  });

  it('records the env before a container is started', async () => {
    const c = fakeContainer({ running: false });
    await new EnvGuard(c.handle, NEW, quiet).ensureCurrent();
    expect(c.stored()).toBe(await envFingerprint(NEW));
    expect(c.events).toHaveLength(1);
  });

  // The 2026-11-23 incident: the rollout started the container from the previous Worker version's Durable Object.
  it('stops a container started with an older env, waits for it to exit, then records the new env', async () => {
    const c = fakeContainer({
      running: true,
      started: await envFingerprint(OLD),
      stopAfterPolls: 3,
    });
    await new EnvGuard(c.handle, NEW, quiet).ensureCurrent();
    expect(c.isRunning()).toBe(false);
    expect(c.events).toEqual(['SIGTERM', `record ${(await envFingerprint(NEW)).slice(0, 6)}`]);
  });

  it('treats a running container with no record (started before this guard existed) as stale', async () => {
    const c = fakeContainer({ running: true });
    await new EnvGuard(c.handle, NEW, quiet).ensureCurrent();
    expect(c.events[0]).toBe('SIGTERM');
    expect(c.stored()).toBe(await envFingerprint(NEW));
  });

  it('signals once and shares the wait between concurrent requests', async () => {
    const c = fakeContainer({
      running: true,
      started: await envFingerprint(OLD),
      stopAfterPolls: 5,
    });
    const guard = new EnvGuard(c.handle, NEW, quiet);
    await Promise.all([guard.ensureCurrent(), guard.ensureCurrent(), guard.ensureCurrent()]);
    expect(c.events.filter((e) => e === 'SIGTERM')).toHaveLength(1);
  });

  it('never lets a new container start while the old one is still running', async () => {
    const c = fakeContainer({
      running: true,
      started: await envFingerprint(OLD),
      stopAfterPolls: 1000,
    });
    const guard = new EnvGuard(c.handle, NEW, { ...quiet, stopTimeoutMs: 10 });
    await expect(guard.ensureCurrent()).rejects.toBeInstanceOf(ContainerStillStopping);
    expect(c.stored()).toBe(await envFingerprint(OLD));
    // A later request keeps waiting without sending SIGTERM again.
    await expect(guard.ensureCurrent()).rejects.toBeInstanceOf(ContainerStillStopping);
    expect(c.events).toEqual(['SIGTERM']);
  });
});

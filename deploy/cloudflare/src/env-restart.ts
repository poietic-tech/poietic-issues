/**
 * Keeps the running container on the current Worker's environment.
 *
 * A container's env is fixed when it starts. During a deploy the container rollout can start the new image from a
 * Durable Object still running the previous Worker version, so the container gets the old env; when the Durable Object
 * later resets to the new version it reattaches to that container and the new env never arrives (incident 2026-11-23,
 * see ADR 0019). So the Durable Object records a fingerprint of the env each time it lets a container start, and
 * before forwarding a request it compares that record with its own env. On a mismatch it stops the container
 * gracefully (SIGTERM: the tracker exits and Litestream does its final sync), waits until it has fully stopped, and
 * only then lets the request start a fresh one. Stop-then-start within the single Durable Object keeps the single
 * writer Litestream needs.
 */

/** What the guard needs from the Durable Object and its container. */
export interface ContainerHandle {
  /** Whether a container instance is running now. */
  running(): boolean;
  /** Send SIGTERM. */
  signalStop(): Promise<void>;
  /** The fingerprint recorded when the running container was started; undefined if none was recorded. */
  readStartedEnv(): Promise<string | undefined>;
  writeStartedEnv(fingerprint: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export interface EnvGuardOptions {
  /** How long to wait for the old container to exit before giving up for this request. */
  stopTimeoutMs?: number;
  pollMs?: number;
  log?: (message: string, fields: Record<string, unknown>) => void;
}

/** SHA-256 over the env with keys sorted, hex. Values never leave the Durable Object. */
export async function envFingerprint(env: Record<string, string>): Promise<string> {
  const canonical = JSON.stringify(
    Object.keys(env)
      .sort()
      .map((k) => [k, env[k]]),
  );
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class ContainerStillStopping extends Error {
  constructor() {
    super('the tracker container is restarting to pick up a new environment');
  }
}

export class EnvGuard {
  readonly #handle: ContainerHandle;
  readonly #fingerprint: Promise<string>;
  readonly #stopTimeoutMs: number;
  readonly #pollMs: number;
  readonly #log: NonNullable<EnvGuardOptions['log']>;
  /** Shared by concurrent requests so the container is signalled and waited for once. */
  #inFlight: Promise<void> | undefined;
  /** This Durable Object instance already sent SIGTERM; don't send it again while Litestream finishes its sync. */
  #signalled = false;

  constructor(handle: ContainerHandle, env: Record<string, string>, options: EnvGuardOptions = {}) {
    this.#handle = handle;
    this.#fingerprint = envFingerprint(env);
    this.#stopTimeoutMs = options.stopTimeoutMs ?? 120_000;
    this.#pollMs = options.pollMs ?? 500;
    this.#log =
      options.log ?? ((message, fields) => console.log(JSON.stringify({ message, ...fields })));
  }

  /**
   * Call before forwarding a request (which starts the container if it isn't running). Afterwards either a container
   * started with this env is running, or none is and the recorded fingerprint is this env's, so the start that
   * follows matches the record. Throws ContainerStillStopping if the old container hasn't exited in time; nothing is
   * started in that case.
   */
  ensureCurrent(): Promise<void> {
    this.#inFlight ??= this.#check().finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
  }

  async #check(): Promise<void> {
    const current = await this.#fingerprint;
    if (this.#handle.running()) {
      const started = await this.#handle.readStartedEnv();
      if (started === current) return;
      this.#log('container environment is stale; restarting the container', {
        started: started?.slice(0, 12) ?? null,
        current: current.slice(0, 12),
      });
      if (!this.#signalled) {
        this.#signalled = true;
        await this.#handle.signalStop();
      }
      const deadline = this.#stopTimeoutMs / this.#pollMs;
      for (let i = 0; this.#handle.running(); i++) {
        if (i >= deadline) throw new ContainerStillStopping();
        await this.#handle.sleep(this.#pollMs);
      }
      this.#log('stale container stopped', { current: current.slice(0, 12) });
    }
    // Not running: whatever starts next starts with this env.
    this.#signalled = false;
    if ((await this.#handle.readStartedEnv()) !== current)
      await this.#handle.writeStartedEnv(current);
  }
}

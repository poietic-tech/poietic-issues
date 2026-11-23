import { Container, getContainer } from '@cloudflare/containers';
import { containerEnv, type WorkerEnv } from './container-env.ts';
import { ContainerStillStopping, EnvGuard } from './env-restart.ts';
import { withoutTargetPort } from './forward.ts';

interface Env extends WorkerEnv {
  TRACKER: DurableObjectNamespace<TrackerContainer>;
}

const STARTED_ENV_KEY = 'started-env';

/**
 * One tracker process. A single Durable Object id ("main") means at most one container at a time — the single
 * writer Litestream requires. An open live-update stream counts as activity and keeps it awake. Before each request
 * EnvGuard restarts a container that was started with a different environment (see env-restart.ts).
 */
export class TrackerContainer extends Container<Env> {
  override defaultPort = 3000;
  override sleepAfter = '30m';
  // The class requests `http://<pingEndpoint>`, so this is host "container" plus path "/healthz".
  override pingEndpoint = 'container/healthz';

  constructor(ctx: ConstructorParameters<typeof Container>[0], env: Env) {
    super(ctx, env);
    this.envVars = containerEnv(env);
    this.#envGuard = new EnvGuard(
      {
        running: () => this.ctx.container?.running ?? false,
        signalStop: () => this.stop('SIGTERM'),
        readStartedEnv: () => this.ctx.storage.get<string>(STARTED_ENV_KEY),
        writeStartedEnv: (fingerprint) => this.ctx.storage.put(STARTED_ENV_KEY, fingerprint),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
      this.envVars,
    );
  }

  readonly #envGuard: EnvGuard;

  override async fetch(request: Request): Promise<Response> {
    try {
      await this.#envGuard.ensureCurrent();
    } catch (error) {
      if (!(error instanceof ContainerStillStopping)) throw error;
      return new Response('The tracker is restarting. Try again in a moment.\n', {
        status: 503,
        headers: { 'retry-after': '5' },
      });
    }
    return super.fetch(request);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return getContainer(env.TRACKER, 'main').fetch(withoutTargetPort(request));
  },
} satisfies ExportedHandler<Env>;

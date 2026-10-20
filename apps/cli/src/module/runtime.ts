import type { Caller, ModuleContext } from '@poietic-tech/cli/module';
import { type ApiClient, createClient, unwrap } from '@poietic-tech/issues-client';
import { findProjectConfig } from '../config.ts';
import { isNetworkError, usage } from '../errors.ts';
import { retryingFetch } from '../fetch.ts';
import type { CommandRuntime } from '../tree/runtime.ts';
import { resolveServer } from './server.ts';
import { ModuleSink, type Write } from './sink.ts';

/** What the module reads from the process; injectable for tests. */
export interface ModuleIO {
  stdout: Write;
  cwd: string;
  readStdin: () => Promise<string>;
}

/** Things the host threw (the caller's own errors): passed back to the host untouched. */
export type HostErrors = WeakSet<object>;

const remember = (errors: HostErrors, error: unknown) => {
  if (typeof error === 'object' && error !== null) errors.add(error);
};

/**
 * One command's runtime under `poietic-tech issues`: the API through the host's caller, which attaches the
 * poietic-tech login. The server is checked, and the caller resolved, only when a command first calls the API.
 */
export class ModuleRuntime implements CommandRuntime {
  readonly out: ModuleSink;
  readonly io: CommandRuntime['io'];
  readonly #ctx: ModuleContext;
  readonly #globals: Record<string, unknown>;
  readonly #hostErrors: HostErrors;
  #client: ApiClient | undefined;

  constructor(
    ctx: ModuleContext,
    io: ModuleIO,
    globals: Record<string, unknown>,
    hostErrors: HostErrors,
  ) {
    this.#ctx = ctx;
    this.#globals = globals;
    this.#hostErrors = hostErrors;
    this.io = { env: ctx.env, cwd: io.cwd, readStdin: io.readStdin };
    const fields =
      typeof globals.fields === 'string'
        ? globals.fields
            .split(',')
            .map((f) => f.trim())
            .filter(Boolean)
        : undefined;
    this.out = new ModuleSink(ctx.output, fields, io.stdout);
  }

  async api(): Promise<ApiClient> {
    if (this.#client) return this.#client;
    // Before the login is read: a server it may not go to is a usage error.
    const baseUrl = resolveServer(this.#ctx.env, this.io.cwd);
    let caller: Caller;
    try {
      caller = await this.#ctx.caller();
    } catch (error) {
      remember(this.#hostErrors, error);
      throw error;
    }
    const send = async (request: Request): Promise<Response> => {
      try {
        return await caller.fetch(request);
      } catch (error) {
        // A network failure is retried and reported by the module; anything else is the host's decision.
        if (!isNetworkError(error)) remember(this.#hostErrors, error);
        throw error;
      }
    };
    this.#client = createClient({ baseUrl, fetch: retryingFetch(send, isNetworkError) });
    return this.#client;
  }

  async call<T>(request: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
    return unwrap(await request);
  }

  /** `-P/--project`, then POIETIC_ISSUES_PROJECT, then `.poietic-issues.json`. */
  project(explicit?: string): string {
    const pick = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
    const project =
      pick(explicit) ??
      pick(this.#globals.project) ??
      pick(this.#ctx.env.POIETIC_ISSUES_PROJECT) ??
      pick(findProjectConfig(this.io.cwd)?.config.project);
    if (!project)
      throw usage(
        'No project given: pass --project <KEY>, set POIETIC_ISSUES_PROJECT, or run `poietic-tech issues init --project <KEY>`',
      );
    return project;
  }
}

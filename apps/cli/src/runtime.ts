import { type ApiClient, unwrap } from '@poietic-tech/issues-client';
import type { Command } from 'commander';
import { type GlobalFlags, resolveConfig, type ResolvedConfig } from './config.ts';
import { usage } from './errors.ts';
import type { CliIO } from './io.ts';
import { Output } from './output.ts';
import { openTransport, type Transport } from './transport.ts';
import type { CommandRuntime, Sink, Tree } from './tree/runtime.ts';

/** Per-invocation state shared by command handlers. */
export class Runtime implements CommandRuntime {
  readonly io: CliIO;
  readonly out: Sink;
  readonly #commandName: string;
  #config: ResolvedConfig | undefined;
  /** A configuration error, raised when a handler first needs the configuration (raw-only commands never do). */
  #configError: unknown;
  #output: Output | undefined;
  #transport: Transport | undefined;

  constructor(io: CliIO, flags: GlobalFlags, commandName = 'poietic-issues') {
    this.io = io;
    this.#commandName = commandName;
    try {
      this.#config = resolveConfig(flags, io);
    } catch (error) {
      this.#configError = error;
    }
    const output = () => (this.#output ??= new Output(io, this.config.format, this.config.fields));
    this.out = {
      get format() {
        return output().format;
      },
      item: (kind, value, human) => output().item(kind, value, human),
      list: (kind, value) => output().list(kind, value),
      note: (text) => output().note(text),
      raw: (text) => io.stdout(text),
      rawBytes: (bytes) =>
        io.stdoutBytes ? io.stdoutBytes(bytes) : io.stdout(new TextDecoder().decode(bytes)),
    };
  }

  get config(): ResolvedConfig {
    if (!this.#config) throw this.#configError;
    return this.#config;
  }

  /** The typed API client (opens the transport on first use). */
  async api(): Promise<ApiClient> {
    this.#transport ??= await openTransport(this.config, this.io);
    return this.#transport.client;
  }

  async describeTransport(): Promise<string> {
    await this.api();
    return this.#transport!.describe;
  }

  /** Awaits an openapi-fetch call and returns its data, throwing the API problem on failure. */
  async call<T>(request: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
    return unwrap(await request);
  }

  /** The project to act on: explicit flag > config; errors with guidance when missing. */
  project(explicit?: string): string {
    const project = explicit ?? this.config.project;
    if (!project)
      throw usage(
        `No project given: pass --project <KEY>, set POIETIC_ISSUES_PROJECT, or run \`${this.#commandName} init --project <KEY>\``,
      );
    return project;
  }

  async close(): Promise<void> {
    await this.#transport?.close();
  }
}

type Handler = (rt: Runtime, args: unknown[], opts: Record<string, unknown>) => Promise<void>;

/** Global options every command inherits, plus the runtime lifecycle. */
export function makeAction(io: CliIO, handler: Handler, commandName?: string) {
  return async (...all: unknown[]) => {
    const command = all.at(-1) as Command;
    const opts = command.optsWithGlobals() as Record<string, unknown>;
    const args = all.slice(0, -2);
    const rt = new Runtime(io, opts as GlobalFlags, commandName);
    try {
      await handler(rt, args, command.opts());
    } finally {
      await rt.close();
    }
  };
}

/** The command tree as the `poietic-issues` binary hosts it: each action builds today's {@link Runtime}. */
export function adminTree(io: CliIO, commandName = 'poietic-issues'): Tree {
  return { commandName, act: (handler) => makeAction(io, handler, commandName) };
}

import type { Command } from 'commander';
import {
  registerLabel,
  registerProject,
  registerStatus,
  registerUser,
  registerView,
} from '../commands/admin.ts';
import {
  registerAttachment,
  registerComment,
  registerEvent,
  registerLink,
} from '../commands/collab.ts';
import { registerField } from '../commands/fields.ts';
import { registerIssue } from '../commands/issues.ts';
import {
  registerApi,
  registerCommands,
  registerInit,
  registerSchema,
  registerWhoami,
} from '../commands/system.ts';
import { registerWebhook } from '../commands/webhooks.ts';
import type { Tree } from './runtime.ts';

export type { CommandRuntime, Sink, Tree } from './runtime.ts';

/** The record commands, in help order. */
const RECORD_COMMANDS = {
  issue: registerIssue,
  comment: registerComment,
  link: registerLink,
  attachment: registerAttachment,
  project: registerProject,
  status: registerStatus,
  label: registerLabel,
  field: registerField,
  view: registerView,
  event: registerEvent,
  webhook: registerWebhook,
  user: registerUser,
  whoami: registerWhoami,
  init: registerInit,
  schema: registerSchema,
  api: registerApi,
} satisfies Record<string, (parent: Command, tree: Tree) => Command>;

export type TreeCommand = keyof typeof RECORD_COMMANDS | 'commands';

/**
 * Registers the command tree onto `parent`, a commander command owned by the host (the `poietic-issues` root
 * or a host CLI's `issues` command). Every command is created through `parent`'s own commander objects.
 *
 * `only` names the commands to register, in that order (default: every record command). `commands`, the
 * machine reference that describes `parent` and everything under it, is registered only when named.
 */
export function registerTree(parent: Command, tree: Tree, only?: readonly string[]): void {
  for (const name of only ?? Object.keys(RECORD_COMMANDS)) {
    if (name === 'commands') registerCommands(parent, tree, () => parent);
    else if (name in RECORD_COMMANDS)
      RECORD_COMMANDS[name as keyof typeof RECORD_COMMANDS](parent, tree);
    else throw new Error(`Unknown command "${name}"`);
  }
}

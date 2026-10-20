import type { Command } from 'commander';
import type { CliIO } from '../io.ts';
import { labelCommand, projectCommand, statusCommand, userCommand, viewCommand } from './admin.ts';
import { attachmentCommand, commentCommand, eventCommand, linkCommand } from './collab.ts';
import { issueCommand } from './issues.ts';
import { fieldCommand } from './fields.ts';
import { webhookCommand } from './webhooks.ts';
import {
  apiCommand,
  authCommand,
  commandsCommand,
  dbCommand,
  initCommand,
  schemaCommand,
  serveCommand,
  whoamiCommand,
} from './system.ts';

/** Every top-level command, in help order. */
export function adminCommands(io: CliIO, program: () => Command): Command[] {
  return [
    issueCommand(io),
    commentCommand(io),
    linkCommand(io),
    attachmentCommand(io),
    projectCommand(io),
    statusCommand(io),
    labelCommand(io),
    fieldCommand(io),
    viewCommand(io),
    eventCommand(io),
    webhookCommand(io),
    userCommand(io),
    authCommand(io),
    whoamiCommand(io),
    initCommand(io),
    dbCommand(io),
    serveCommand(io),
    schemaCommand(io),
    apiCommand(io),
    commandsCommand(io, program),
  ];
}

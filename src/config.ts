import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ThreadConfigSchema = z.object({
  model: z.string().min(1).optional(),
  permission: z.string().optional(),
  isolation: z.enum(["worktree"]).optional(),
});

const ThreadEntrySchema = z.object({
  name: z.string().min(1),
  channelId: z.string().min(1),
  model: z.string().min(1).optional(),
  projectPath: z.string().min(1).optional(),
  permission: z.string().optional(),
  isolation: z.enum(["worktree"]).optional(),
  startup: z.boolean().optional().default(false),
});

const ProjectSchema = z.object({
  name: z.string().min(1),
  channelId: z.string().min(1),
  projectPath: z.string().min(1),
  model: z.string().min(1),
  thread: ThreadConfigSchema.optional(),
  threads: z.array(ThreadEntrySchema).optional().default([]),
  startup: z.boolean().optional().default(false),
  permissionTools: z.array(z.string()).optional().default([]),
});

const ServerSchema = z.object({
  name: z.string().min(1),
  discord: z.object({
    botToken: z.string().min(1),
    guildId: z.string().optional(),
    ownerUserId: z.string().min(1),
  }),
  tmux: z.object({
    session: z.string().min(1),
  }),
  projects: z.array(ProjectSchema).min(1),
  permissionTools: z.array(z.string()).optional().default([]),
  generalChannelId: z.string().optional(),
});

const ConfigSchema = z.object({
  schemaVersion: z.literal(2),
  servers: z.array(ServerSchema).min(1),
});

export type Config = z.infer<typeof ConfigSchema>;
export type Server = z.infer<typeof ServerSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type ThreadConfig = z.infer<typeof ThreadConfigSchema>;
export type ThreadEntry = z.infer<typeof ThreadEntrySchema>;

const DEFAULT_CONFIG_PATH = join(homedir(), '.discord-bridge', 'config.json');

export function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): Config {
  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  return ConfigSchema.parse(raw);
}

export function resolveThreadConfig(
  project: Project,
  threadChannelId: string,
): {
  model: string;
  projectPath: string;
  permission: string | undefined;
  isolation: 'worktree' | undefined;
} {
  const entry = project.threads.find(t => t.channelId === threadChannelId);
  return {
    model:       entry?.model       ?? project.thread?.model       ?? project.model,
    projectPath: entry?.projectPath ?? project.projectPath,
    permission:  entry?.permission  ?? project.thread?.permission,
    isolation:   entry?.isolation   ?? project.thread?.isolation,
  };
}

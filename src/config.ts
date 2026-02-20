import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ThreadConfigSchema = z.object({
  model: z.string().min(1).optional(),
  permission: z.string().optional(),
});

const ProjectSchema = z.object({
  name: z.string().min(1),
  channelId: z.string().min(1),
  projectPath: z.string().min(1),
  model: z.string().min(1),
  thread: ThreadConfigSchema.optional(),
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
});

const ConfigSchema = z.object({
  schemaVersion: z.literal(2),
  servers: z.array(ServerSchema).min(1),
});

export type Config = z.infer<typeof ConfigSchema>;
export type Server = z.infer<typeof ServerSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type ThreadConfig = z.infer<typeof ThreadConfigSchema>;

const DEFAULT_CONFIG_PATH = join(homedir(), '.discord-bridge', 'config.json');

export function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): Config {
  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  return ConfigSchema.parse(raw);
}

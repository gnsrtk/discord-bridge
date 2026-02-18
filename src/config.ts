import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ProjectSchema = z.object({
  name: z.string().min(1),
  channelId: z.string().min(1),
  projectPath: z.string().min(1),
  model: z.string().min(1),
});

const ConfigSchema = z.object({
  schemaVersion: z.literal(1),
  tmux: z.object({
    session: z.string().min(1),
  }),
  discord: z.object({
    botToken: z.string().min(1),
    guildId: z.string().optional(),
    ownerUserId: z.string().min(1),
  }),
  projects: z.array(ProjectSchema).min(1),
});

export type Config = z.infer<typeof ConfigSchema>;
export type Project = z.infer<typeof ProjectSchema>;

const DEFAULT_CONFIG_PATH = join(homedir(), '.discord-bridge', 'config.json');

export function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): Config {
  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  return ConfigSchema.parse(raw);
}

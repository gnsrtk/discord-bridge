import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.js';

const TMP_DIR = join(tmpdir(), 'discord-bridge-config-test');
const CONFIG_PATH = join(TMP_DIR, 'config.json');

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

const validConfig = {
  schemaVersion: 1,
  tmux: { session: 'discord-bridge' },
  discord: {
    botToken: 'Bot.token.here',
    guildId: '111111111111111111',
    ownerUserId: '222222222222222222',
  },
  projects: [
    {
      name: 'test-project',
      channelId: '444444444444444444',
      projectPath: '/Users/test/projects/test-project',
      model: 'claude-sonnet-4-5',
    },
  ],
};

describe('loadConfig', () => {
  test('正常なJSONを正しくパースする', () => {
    writeFileSync(CONFIG_PATH, JSON.stringify(validConfig));
    const config = loadConfig(CONFIG_PATH);
    expect(config).toEqual(validConfig);
  });

  test('全フィールドが必須（デフォルト値なし）', () => {
    const partial = { schemaVersion: 1 };
    writeFileSync(CONFIG_PATH, JSON.stringify(partial));
    expect(() => loadConfig(CONFIG_PATH)).toThrow();
  });

  test('欠落フィールドがあればZodエラーをスロー', () => {
    const missing = {
      ...validConfig,
      discord: {
        guildId: '111',
        ownerUserId: '222',
        // botToken 欠落
      },
    };
    writeFileSync(CONFIG_PATH, JSON.stringify(missing));
    expect(() => loadConfig(CONFIG_PATH)).toThrow(/botToken/);
  });
});

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
  schemaVersion: 2,
  servers: [
    {
      name: 'personal',
      discord: {
        botToken: 'Bot.token.here',
        guildId: '111111111111111111',
        ownerUserId: '222222222222222222',
      },
      tmux: { session: 'personal' },
      projects: [
        {
          name: 'test-project',
          channelId: '444444444444444444',
          projectPath: '/Users/test/projects/test-project',
          model: 'claude-sonnet-4-6',
        },
      ],
    },
  ],
};

describe('loadConfig', () => {
  test('正常なJSONを正しくパースする', () => {
    writeFileSync(CONFIG_PATH, JSON.stringify(validConfig));
    const config = loadConfig(CONFIG_PATH);
    // permissionTools はデフォルト値 [] が Zod で付与される
    expect(config).toEqual({
      ...validConfig,
      servers: validConfig.servers.map((s) => ({ ...s, permissionTools: [] })),
    });
  });

  test('全フィールドが必須（デフォルト値なし）', () => {
    const partial = { schemaVersion: 2 };
    writeFileSync(CONFIG_PATH, JSON.stringify(partial));
    expect(() => loadConfig(CONFIG_PATH)).toThrow();
  });

  test('欠落フィールドがあればZodエラーをスロー', () => {
    const missing = {
      schemaVersion: 2,
      servers: [
        {
          name: 'personal',
          discord: {
            guildId: '111',
            ownerUserId: '222',
            // botToken 欠落
          },
          tmux: { session: 's' },
          projects: [{ name: 'p', channelId: 'c', projectPath: '/p', model: 'm' }],
        },
      ],
    };
    writeFileSync(CONFIG_PATH, JSON.stringify(missing));
    expect(() => loadConfig(CONFIG_PATH)).toThrow(/botToken/);
  });

  test('v1 形式は reject される', () => {
    const v1 = {
      schemaVersion: 1,
      tmux: { session: 's' },
      discord: { botToken: 't', ownerUserId: 'o' },
      projects: [{ name: 'p', channelId: 'c', projectPath: '/p', model: 'm' }],
    };
    writeFileSync(CONFIG_PATH, JSON.stringify(v1));
    expect(() => loadConfig(CONFIG_PATH)).toThrow();
  });

  test('servers が空配列は reject される', () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ schemaVersion: 2, servers: [] }));
    expect(() => loadConfig(CONFIG_PATH)).toThrow();
  });

  test('server.projects が空配列は reject される', () => {
    const cfg = {
      schemaVersion: 2,
      servers: [
        {
          name: 's',
          discord: { botToken: 't', ownerUserId: 'o' },
          tmux: { session: 's' },
          projects: [],
        },
      ],
    };
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg));
    expect(() => loadConfig(CONFIG_PATH)).toThrow();
  });
});

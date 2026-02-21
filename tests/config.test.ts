import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, resolveThreadConfig } from '../src/config.js';

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
      servers: validConfig.servers.map((s) => ({
        ...s,
        permissionTools: [],
        projects: s.projects.map((p) => ({ ...p, startup: false, threads: [], permissionTools: [] })),
      })),
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

  test('thread.isolation: "worktree" を受け付ける', () => {
    const cfg = {
      ...validConfig,
      servers: [
        {
          ...validConfig.servers[0],
          projects: [
            {
              ...validConfig.servers[0].projects[0],
              thread: { model: 'claude-sonnet-4-6', isolation: 'worktree' },
            },
          ],
        },
      ],
    };
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg));
    const config = loadConfig(CONFIG_PATH);
    expect(config.servers[0].projects[0].thread?.isolation).toBe('worktree');
  });

  test('thread.isolation: 不正な値は reject される', () => {
    const cfg = {
      ...validConfig,
      servers: [
        {
          ...validConfig.servers[0],
          projects: [
            {
              ...validConfig.servers[0].projects[0],
              thread: { isolation: 'invalid' },
            },
          ],
        },
      ],
    };
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg));
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

  test('startup: true を受け付ける', () => {
    const cfg = {
      ...validConfig,
      servers: [
        {
          ...validConfig.servers[0],
          projects: [
            { ...validConfig.servers[0].projects[0], startup: true },
          ],
        },
      ],
    };
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg));
    const config = loadConfig(CONFIG_PATH);
    expect(config.servers[0].projects[0].startup).toBe(true);
  });

  test('startup 省略時はデフォルト false になる', () => {
    writeFileSync(CONFIG_PATH, JSON.stringify(validConfig));
    const config = loadConfig(CONFIG_PATH);
    expect(config.servers[0].projects[0].startup).toBe(false);
  });

  test('startup に文字列を渡すと reject される', () => {
    const cfg = {
      ...validConfig,
      servers: [
        {
          ...validConfig.servers[0],
          projects: [
            { ...validConfig.servers[0].projects[0], startup: 'on' },
          ],
        },
      ],
    };
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg));
    expect(() => loadConfig(CONFIG_PATH)).toThrow();
  });
});

describe('resolveThreadConfig', () => {
  type Thread = ReturnType<typeof loadConfig>['servers'][0]['projects'][0]['threads'][0];
  type Project = ReturnType<typeof loadConfig>['servers'][0]['projects'][0];

  const makeProject = (overrides: Partial<Project> = {}): Project => ({
    name: 'proj',
    channelId: '111',
    projectPath: '/default/path',
    model: 'claude-sonnet-4-6',
    startup: false,
    threads: [],
    permissionTools: [],
    ...overrides,
  });

  test('threads[] エントリが一致すればそのフィールドを使う', () => {
    const project = makeProject({
      threads: [{
        name: 'th',
        channelId: 'th-ch-1',
        model: 'claude-opus-4-6',
        projectPath: '/override/path',
        permission: 'bypassPermissions',
        isolation: 'worktree' as const,
        startup: false,
      }],
    });
    const result = resolveThreadConfig(project, 'th-ch-1');
    expect(result.model).toBe('claude-opus-4-6');
    expect(result.projectPath).toBe('/override/path');
    expect(result.permission).toBe('bypassPermissions');
    expect(result.isolation).toBe('worktree');
  });

  test('threads[] に一致がなければ project.thread にフォールバック', () => {
    const project = makeProject({
      thread: { model: 'claude-haiku-4-5', permission: 'bypassPermissions', isolation: 'worktree' as const },
      threads: [],
    });
    const result = resolveThreadConfig(project, 'unknown-ch');
    expect(result.model).toBe('claude-haiku-4-5');
    expect(result.permission).toBe('bypassPermissions');
    expect(result.isolation).toBe('worktree');
  });

  test('threads[] と project.thread 両方なければ project デフォルト', () => {
    const project = makeProject({ threads: [] });
    const result = resolveThreadConfig(project, 'unknown-ch');
    expect(result.model).toBe('claude-sonnet-4-6');
    expect(result.projectPath).toBe('/default/path');
    expect(result.permission).toBeUndefined();
    expect(result.isolation).toBeUndefined();
  });

  test('threads[] エントリが省略したフィールドは project.thread にフォールバック', () => {
    const project = makeProject({
      thread: { model: 'claude-opus-4-6', isolation: 'worktree' as const },
      threads: [{ name: 'th', channelId: 'th-ch-1', startup: false }],
    });
    const result = resolveThreadConfig(project, 'th-ch-1');
    // model は thread エントリ省略 → project.thread.model
    expect(result.model).toBe('claude-opus-4-6');
    // isolation も同様
    expect(result.isolation).toBe('worktree');
  });
});

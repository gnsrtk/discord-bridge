import { describe, test, expect, vi, beforeEach } from 'vitest';
import { listRunningWindows, startProjectWindow, stopProjectWindow, buildControlPanel, autoStartProjects } from '../src/bot.js';
import { ThreadStateManager } from '../src/thread-state.js';
import type { Project } from '../src/config.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';

const mockProject = (name: string, startup = false): Project => ({
  name,
  channelId: `ch-${name}`,
  projectPath: `/home/user/${name}`,
  model: 'claude-sonnet-4-6',
  thread: undefined,
  startup,
});

function getCustomIds(components: ReturnType<typeof buildControlPanel>['components']): string[] {
  return components.flatMap(row => row.components).map(b => {
    const json = b.toJSON();
    return 'custom_id' in json ? String(json.custom_id) : '';
  });
}

describe('listRunningWindows', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  test('実行中のウィンドウ名を Set で返す', () => {
    vi.mocked(execFileSync).mockReturnValue('main\ndiscord-bridge\n' as never);
    const result = listRunningWindows('my-session');
    expect(result).toEqual(new Set(['main', 'discord-bridge']));
    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      'tmux', ['list-windows', '-t', 'my-session', '-F', '#{window_name}'],
      { encoding: 'utf8' },
    );
  });

  test('tmux が失敗した場合は空 Set を返す', () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('no session'); });
    const result = listRunningWindows('missing-session');
    expect(result).toEqual(new Set());
  });

  test('空文字列が返った場合は空 Set を返す', () => {
    vi.mocked(execFileSync).mockReturnValue('' as never);
    const result = listRunningWindows('empty-session');
    expect(result).toEqual(new Set());
  });
});

describe('startProjectWindow', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  test('new-window + send-keys を正しい引数で呼ぶ', () => {
    const project = mockProject('my-app');
    startProjectWindow('my-session', project);
    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls[0]).toEqual(['tmux', ['new-window', '-t', 'my-session', '-n', 'my-app', '-d']]);
    expect(calls[1]![0]).toBe('tmux');
    expect(calls[1]![1]).toEqual(expect.arrayContaining(['send-keys', '-t', 'my-session:my-app']));
    expect(String(calls[1]![1]![3])).toContain('claude --model');
    expect(String(calls[1]![1]![3])).toContain('my-app');
    expect(String(calls[1]![1]![3])).toContain('claude-sonnet-4-6');
  });
});

describe('stopProjectWindow', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  test('kill-window を正しい引数で呼ぶ', () => {
    stopProjectWindow('my-session', 'my-app');
    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      'tmux', ['kill-window', '-t', 'my-session:my-app'],
    );
  });
});

describe('buildControlPanel', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  test('running プロジェクトに Stop ボタン、stopped に Start ボタンを生成する', () => {
    vi.mocked(execFileSync).mockReturnValue('proj-a\n' as never);
    const stateManager = new ThreadStateManager('/tmp/test-state-control-nonexistent.json');
    const projects = [mockProject('proj-a'), mockProject('proj-b')];
    const { content, components } = buildControlPanel('sess', projects, stateManager, 'test-server');

    expect(content).toContain('🟢 `proj-a` — running');
    expect(content).toContain('⭕ `proj-b` — stopped');
    expect(content).toContain('🎮 **Control Panel**');
    expect(content).toContain('_Updated:');

    const ids = getCustomIds(components);
    expect(ids).toContain('ctrl:stop:proj-a');
    expect(ids).toContain('ctrl:start:proj-b');
    expect(ids).toContain('ctrl:refresh');
  });

  test('全プロジェクト stopped の場合は Start ボタンのみ生成', () => {
    vi.mocked(execFileSync).mockReturnValue('' as never);
    const stateManager = new ThreadStateManager('/tmp/test-state-control-nonexistent2.json');
    const projects = [mockProject('proj-x')];
    const { components } = buildControlPanel('sess', projects, stateManager, 'test-server');

    const ids = getCustomIds(components);
    expect(ids).toContain('ctrl:start:proj-x');
    expect(ids.some(id => id.startsWith('ctrl:stop:'))).toBe(false);
    expect(ids).toContain('ctrl:refresh');
  });

  test('5 件超のボタンは複数の ActionRow に分割される', () => {
    vi.mocked(execFileSync).mockReturnValue('' as never);
    const stateManager = new ThreadStateManager('/tmp/test-state-control-nonexistent3.json');
    // 5 プロジェクト + refresh = 6 ボタン → 2 行
    const projects = Array.from({ length: 5 }, (_, i) => mockProject(`proj-${i}`));
    const { components } = buildControlPanel('sess', projects, stateManager, 'test-server');
    expect(components.length).toBeGreaterThan(1);
    const allBtns = components.flatMap(row => row.components);
    expect(allBtns.length).toBe(6);
  });
});

describe('autoStartProjects', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  test('startup: true のプロジェクトを起動する', () => {
    // listRunningWindows → 空 Set
    vi.mocked(execFileSync).mockReturnValueOnce('' as never);
    // startProjectWindow の new-window
    vi.mocked(execFileSync).mockReturnValueOnce(undefined as never);
    // startProjectWindow の send-keys
    vi.mocked(execFileSync).mockReturnValueOnce(undefined as never);

    const projects = [mockProject('proj-a', true), mockProject('proj-b', false)];
    autoStartProjects('my-session', projects);

    const calls = vi.mocked(execFileSync).mock.calls;
    // list-windows + new-window + send-keys = 3 回
    expect(calls.length).toBe(3);
    // proj-a だけ起動
    expect(String(calls[1]![1])).toContain('proj-a');
  });

  test('startup: false のプロジェクトは起動しない', () => {
    vi.mocked(execFileSync).mockReturnValueOnce('' as never);
    const projects = [mockProject('proj-x', false)];
    autoStartProjects('my-session', projects);

    // list-windows の1回のみ
    expect(vi.mocked(execFileSync).mock.calls.length).toBe(1);
  });

  test('既に running なら起動しない', () => {
    // listRunningWindows → 'proj-c' が running
    vi.mocked(execFileSync).mockReturnValueOnce('proj-c\n' as never);
    const projects = [mockProject('proj-c', true)];
    autoStartProjects('my-session', projects);

    // list-windows の1回のみ（startProjectWindow は呼ばれない）
    expect(vi.mocked(execFileSync).mock.calls.length).toBe(1);
  });

  test('startup: false かつ running なら停止する', () => {
    // listRunningWindows → 'proj-d' が running
    vi.mocked(execFileSync).mockReturnValueOnce('proj-d\n' as never);
    // stopProjectWindow の kill-window
    vi.mocked(execFileSync).mockReturnValueOnce(undefined as never);

    const projects = [mockProject('proj-d', false)];
    autoStartProjects('my-session', projects);

    const calls = vi.mocked(execFileSync).mock.calls;
    // list-windows + kill-window = 2 回
    expect(calls.length).toBe(2);
    expect(String(calls[1]![1])).toContain('proj-d');
  });
});

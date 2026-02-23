import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  writeThreadTracking,
  handleInteractionCreate,
  handleButtonInteraction,
  createThreadPane,
  killThreadPane,
  buildPermissionFlag,
  detectWorktreePath,
  checkWorktreeClean,
  appendThreadToConfig,
  autoStartStaticThreads,
} from '../src/bot.js';
import { type ThreadPaneInfo } from '../src/thread-state.js';
import { TmuxSender } from '../src/tmux-sender.js';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

const makeThreadPaneInfo = (paneId: string): ThreadPaneInfo => ({
  paneId,
  paneStartedAt: '2026-02-21T10:00:00Z',
  parentChannelId: 'parent-ch-111',
  projectPath: '/path/to/project',
  serverName: 'personal',
  createdAt: '2026-02-21T10:00:00Z',
  launchCmd: 'claude --model opus',
});

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// writeThreadTracking
// ---------------------------------------------------------------------------

describe('writeThreadTracking', () => {
  const parentChannelId = 'test-wtt-parent-123';
  const trackingPath = `/tmp/discord-bridge-thread-${parentChannelId}.json`;

  afterEach(() => {
    try { unlinkSync(trackingPath); } catch { /* ignore */ }
  });

  test('threadId を書き込む', () => {
    writeThreadTracking(parentChannelId, 'thread-456');
    expect(existsSync(trackingPath)).toBe(true);
    const data = JSON.parse(readFileSync(trackingPath, 'utf-8'));
    expect(data.threadId).toBe('thread-456');
  });

  test('threadId が null の場合はファイルを削除する', () => {
    writeFileSync(trackingPath, JSON.stringify({ threadId: 'old-thread' }));
    writeThreadTracking(parentChannelId, null);
    expect(existsSync(trackingPath)).toBe(false);
  });

  test('ファイルが存在しない状態で null を渡してもエラーにならない', () => {
    expect(() => writeThreadTracking('nonexistent-channel-xyz', null)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// handleInteractionCreate with threadParentMap
// ---------------------------------------------------------------------------

describe('handleInteractionCreate with threadParentMap', () => {
  const makeBtn = (overrides: object = {}) => ({
    isButton: () => true,
    user: { id: 'owner-123' },
    channelId: 'thread-ch-789',
    customId: '0:はい',
    reply: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });

  const channelSenderMap = new Map<string, TmuxSender>([
    ['parent-ch-111', new TmuxSender('0:1')],
  ]);
  const defaultSender = new TmuxSender('0:0');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('スレッド内ボタン → threadParentMap で親チャンネルの sender を使用', async () => {
    const threadParentMap = new Map([['thread-ch-789', 'parent-ch-111']]);
    const btn = makeBtn();

    await handleInteractionCreate(btn, 'owner-123', channelSenderMap, defaultSender, threadParentMap);

    const calls = vi.mocked(execFileSync).mock.calls;
    // parent-ch-111 の sender (0:1) で送信される
    expect(calls[0]).toEqual(['tmux', ['send-keys', '-t', '0:1', '-l', 'はい'], { stdio: 'inherit' }]);
  });

  test('threadParentMap に登録なし → defaultSender を使用', async () => {
    const threadParentMap = new Map<string, string>();
    const btn = makeBtn();

    await handleInteractionCreate(btn, 'owner-123', channelSenderMap, defaultSender, threadParentMap);

    const calls = vi.mocked(execFileSync).mock.calls;
    // defaultSender (0:0) で送信される
    expect(calls[0]).toEqual(['tmux', ['send-keys', '-t', '0:0', '-l', 'はい'], { stdio: 'inherit' }]);
  });

  test('threadParentMap undefined (後方互換) → defaultSender を使用', async () => {
    const btn = makeBtn();

    await handleInteractionCreate(btn, 'owner-123', channelSenderMap, defaultSender);

    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls[0]).toEqual(['tmux', ['send-keys', '-t', '0:0', '-l', 'はい'], { stdio: 'inherit' }]);
  });

  test('perm: ボタン in スレッド → threadParentMap で親チャンネルID解決して IPC ファイルパス一致', async () => {
    const threadParentMap = new Map([['111222333444555', 'parent-ch-111']]);
    const btn = makeBtn({
      customId: 'perm:allow',
      channelId: '111222333444555',
    });
    const respPath = '/tmp/discord-bridge-perm-parent-ch-111.json';
    try { unlinkSync(respPath); } catch { /* ignore */ }

    await handleInteractionCreate(btn, 'owner-123', channelSenderMap, defaultSender, threadParentMap);

    expect(btn.reply).toHaveBeenCalledWith({ content: '✅ Allowed', ephemeral: false });
    expect(existsSync(respPath)).toBe(true);
    const data = JSON.parse(readFileSync(respPath, 'utf-8'));
    expect(data.decision).toBe('allow');

    try { unlinkSync(respPath); } catch { /* ignore */ }
  });
});

// ---------------------------------------------------------------------------
// buildPermissionFlag
// ---------------------------------------------------------------------------

describe('buildPermissionFlag', () => {
  test('bypassPermissions → --dangerously-skip-permissions', () => {
    expect(buildPermissionFlag('bypassPermissions')).toBe(' --dangerously-skip-permissions');
  });

  test('undefined → 空文字列', () => {
    expect(buildPermissionFlag(undefined)).toBe('');
  });

  test('default → 空文字列', () => {
    expect(buildPermissionFlag('default')).toBe('');
  });

  test('未知の値 → 空文字列', () => {
    expect(buildPermissionFlag('unknown')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// createThreadPane
// ---------------------------------------------------------------------------

describe('createThreadPane', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('split-window + send-keys を実行し pane ID を返す', () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce('%42\n' as unknown as Buffer)  // split-window → pane ID
      .mockReturnValueOnce('' as unknown as Buffer);       // send-keys

    const paneId = createThreadPane('sess', 'proj-win', '/path/to/project', 'opus', 'thread-999');

    expect(paneId).toBe('%42');
    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls[0]).toEqual([
      'tmux',
      ['split-window', '-t', 'sess:proj-win', '-d', '-P', '-F', '#{pane_id}'],
      { encoding: 'utf8' },
    ]);
    expect(calls[1][0]).toBe('tmux');
    expect(calls[1][1][0]).toBe('send-keys');
    expect(calls[1][1][1]).toBe('-t');
    expect(calls[1][1][2]).toBe('%42');
    // cmd に DISCORD_BRIDGE_THREAD_ID が含まれる
    const cmd = calls[1][1][3] as string;
    expect(cmd).toContain('DISCORD_BRIDGE_THREAD_ID=thread-999');
    expect(cmd).toContain('/path/to/project');
    expect(cmd).toContain('claude --model');
    expect(cmd).not.toContain('--dangerously-skip-permissions');
  });

  test('permission=bypassPermissions → --dangerously-skip-permissions が cmd に含まれる', () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce('%43\n' as unknown as Buffer)
      .mockReturnValueOnce('' as unknown as Buffer);

    createThreadPane('sess', 'win', '/path', 'haiku', 'th-2', 'bypassPermissions');

    const cmd = vi.mocked(execFileSync).mock.calls[1][1][3] as string;
    expect(cmd).toContain('--dangerously-skip-permissions');
  });

  test('thread.model でモデルオーバーライド', () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce('%44\n' as unknown as Buffer)
      .mockReturnValueOnce('' as unknown as Buffer);

    createThreadPane('sess', 'win', '/path', 'claude-haiku-4-5-20251001', 'th-3');

    const cmd = vi.mocked(execFileSync).mock.calls[1][1][3] as string;
    expect(cmd).toContain('claude-haiku-4-5-20251001');
  });

  test('isolation=worktree → -w フラグが cmd に含まれる', () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce('%45\n' as unknown as Buffer)
      .mockReturnValueOnce('' as unknown as Buffer);

    createThreadPane('sess', 'win', '/path', 'opus', 'th-4', undefined, 'worktree');

    const cmd = vi.mocked(execFileSync).mock.calls[1][1][3] as string;
    expect(cmd).toContain(' -w');
    expect(cmd).not.toContain('--dangerously-skip-permissions');
  });

  test('isolation=worktree + bypassPermissions → 両方のフラグが含まれる', () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce('%46\n' as unknown as Buffer)
      .mockReturnValueOnce('' as unknown as Buffer);

    createThreadPane('sess', 'win', '/path', 'opus', 'th-5', 'bypassPermissions', 'worktree');

    const cmd = vi.mocked(execFileSync).mock.calls[1][1][3] as string;
    expect(cmd).toContain(' -w');
    expect(cmd).toContain('--dangerously-skip-permissions');
  });

  test('isolation=undefined → -w フラグが含まれない', () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce('%47\n' as unknown as Buffer)
      .mockReturnValueOnce('' as unknown as Buffer);

    createThreadPane('sess', 'win', '/path', 'opus', 'th-6');

    const cmd = vi.mocked(execFileSync).mock.calls[1][1][3] as string;
    expect(cmd).not.toContain(' -w');
  });

  test('split-window 失敗時はエラーを伝播する', () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => { throw new Error('tmux error'); });
    expect(() => createThreadPane('sess', 'win', '/path', 'opus', 'th-1')).toThrow('tmux error');
  });
});

// ---------------------------------------------------------------------------
// killThreadPane
// ---------------------------------------------------------------------------

describe('killThreadPane', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('kill-pane コマンドを実行する', () => {
    killThreadPane('%42');
    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls[0]).toEqual(['tmux', ['kill-pane', '-t', '%42']]);
  });

  test('pane が存在しなくてもエラーにならない', () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => { throw new Error('pane not found'); });
    expect(() => killThreadPane('%99')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// handleButtonInteraction with threadPaneMap
// ---------------------------------------------------------------------------

describe('handleButtonInteraction with threadPaneMap', () => {
  const channelSenderMap = new Map<string, TmuxSender>([
    ['parent-ch-111', new TmuxSender('0:1')],
  ]);
  const defaultSender = new TmuxSender('0:0');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('threadPaneMap にエントリあり → pane sender を使用', () => {
    const threadPaneMap = new Map([['thread-ch-abc', '%55']]);
    handleButtonInteraction('parent-ch-111', '0:はい', channelSenderMap, defaultSender, 'thread-ch-abc', threadPaneMap);

    const calls = vi.mocked(execFileSync).mock.calls;
    // pane %55 の sender で送信される
    expect(calls[0]).toEqual(['tmux', ['send-keys', '-t', '%55', '-l', 'はい'], { stdio: 'inherit' }]);
  });

  test('threadPaneMap にエントリなし → 通常の channelSenderMap を使用', () => {
    const threadPaneMap = new Map<string, string>();
    handleButtonInteraction('parent-ch-111', '0:はい', channelSenderMap, defaultSender, 'thread-ch-abc', threadPaneMap);

    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls[0]).toEqual(['tmux', ['send-keys', '-t', '0:1', '-l', 'はい'], { stdio: 'inherit' }]);
  });

  test('originalChannelId undefined → channelSenderMap を使用', () => {
    const threadPaneMap = new Map([['thread-ch-abc', '%55']]);
    handleButtonInteraction('parent-ch-111', '0:はい', channelSenderMap, defaultSender, undefined, threadPaneMap);

    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls[0]).toEqual(['tmux', ['send-keys', '-t', '0:1', '-l', 'はい'], { stdio: 'inherit' }]);
  });
});

// ---------------------------------------------------------------------------
// handleInteractionCreate with threadPaneMap
// ---------------------------------------------------------------------------

describe('handleInteractionCreate with threadPaneMap', () => {
  const makeBtn = (overrides: object = {}) => ({
    isButton: () => true,
    user: { id: 'owner-123' },
    channelId: 'thread-ch-789',
    customId: '0:はい',
    reply: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });

  const channelSenderMap = new Map<string, TmuxSender>([
    ['parent-ch-111', new TmuxSender('0:1')],
  ]);
  const defaultSender = new TmuxSender('0:0');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('スレッド内ボタン + threadPaneMap あり → pane sender を使用', async () => {
    const threadParentMap = new Map([['thread-ch-789', 'parent-ch-111']]);
    const threadPaneMap = new Map([['thread-ch-789', '%60']]);
    const btn = makeBtn();

    await handleInteractionCreate(btn, 'owner-123', channelSenderMap, defaultSender, threadParentMap, threadPaneMap);

    const calls = vi.mocked(execFileSync).mock.calls;
    // pane %60 で送信される
    expect(calls[0]).toEqual(['tmux', ['send-keys', '-t', '%60', '-l', 'はい'], { stdio: 'inherit' }]);
  });

  test('スレッド内ボタン + threadPaneMap なし → 親 sender を使用', async () => {
    const threadParentMap = new Map([['thread-ch-789', 'parent-ch-111']]);
    const threadPaneMap = new Map<string, string>();
    const btn = makeBtn();

    await handleInteractionCreate(btn, 'owner-123', channelSenderMap, defaultSender, threadParentMap, threadPaneMap);

    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls[0]).toEqual(['tmux', ['send-keys', '-t', '0:1', '-l', 'はい'], { stdio: 'inherit' }]);
  });
});

// ---------------------------------------------------------------------------
// handleButtonInteraction with ThreadPaneInfo
// ---------------------------------------------------------------------------

describe('handleButtonInteraction with ThreadPaneInfo', () => {
  const channelSenderMap = new Map<string, TmuxSender>([
    ['parent-ch-111', new TmuxSender('0:1')],
  ]);
  const defaultSender = new TmuxSender('0:0');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('ThreadPaneInfo エントリ → paneId の sender を使用', () => {
    const threadPaneMap = new Map([['thread-ch-abc', makeThreadPaneInfo('%55')]]);
    handleButtonInteraction('parent-ch-111', '0:はい', channelSenderMap, defaultSender, 'thread-ch-abc', threadPaneMap);

    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls[0]).toEqual(['tmux', ['send-keys', '-t', '%55', '-l', 'はい'], { stdio: 'inherit' }]);
  });
});

// ---------------------------------------------------------------------------
// handleInteractionCreate with ThreadPaneInfo
// ---------------------------------------------------------------------------

describe('handleInteractionCreate with ThreadPaneInfo', () => {
  const makeBtn = (overrides: object = {}) => ({
    isButton: () => true,
    user: { id: 'owner-123' },
    channelId: 'thread-ch-789',
    customId: '0:はい',
    reply: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });

  const channelSenderMap = new Map<string, TmuxSender>([
    ['parent-ch-111', new TmuxSender('0:1')],
  ]);
  const defaultSender = new TmuxSender('0:0');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('ThreadPaneInfo + threadPaneMap あり → paneId の sender を使用', async () => {
    const threadParentMap = new Map([['thread-ch-789', 'parent-ch-111']]);
    const threadPaneMap = new Map([['thread-ch-789', makeThreadPaneInfo('%60')]]);
    const btn = makeBtn();

    await handleInteractionCreate(btn, 'owner-123', channelSenderMap, defaultSender, threadParentMap, threadPaneMap);

    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls[0]).toEqual(['tmux', ['send-keys', '-t', '%60', '-l', 'はい'], { stdio: 'inherit' }]);
  });
});

// ---------------------------------------------------------------------------
// detectWorktreePath
// ---------------------------------------------------------------------------

describe('detectWorktreePath', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('worktree を検出して最初の新規パスを返す', async () => {
    const output = 'worktree /path/to/project\nbranch refs/heads/main\n\nworktree /path/to/project/.claude/worktrees/abc\nbranch refs/heads/worktree-abc\n\n';
    vi.mocked(execFileSync).mockReturnValue(output as unknown as Buffer);

    const result = await detectWorktreePath('/path/to/project', new Set(), 1, 10);
    expect(result).toBe('/path/to/project/.claude/worktrees/abc');
  });

  test('既知パスは除外される', async () => {
    const output = 'worktree /path/.claude/worktrees/old\nbranch refs/heads/old\n\nworktree /path/.claude/worktrees/new\nbranch refs/heads/new\n\n';
    vi.mocked(execFileSync).mockReturnValue(output as unknown as Buffer);

    const known = new Set(['/path/.claude/worktrees/old']);
    const result = await detectWorktreePath('/path', known, 1, 10);
    expect(result).toBe('/path/.claude/worktrees/new');
  });

  test('worktree が見つからない場合は null を返す', async () => {
    const output = 'worktree /path/to/project\nbranch refs/heads/main\n\n';
    vi.mocked(execFileSync).mockReturnValue(output as unknown as Buffer);

    const result = await detectWorktreePath('/path', new Set(), 1, 10);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkWorktreeClean
// ---------------------------------------------------------------------------

describe('checkWorktreeClean', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('clean worktree → 空文字列', () => {
    vi.mocked(execFileSync).mockReturnValue('' as unknown as Buffer);
    expect(checkWorktreeClean('/path')).toBe('');
  });

  test('dirty worktree → ステータス文字列', () => {
    vi.mocked(execFileSync).mockReturnValue(' M src/file.ts\n' as unknown as Buffer);
    expect(checkWorktreeClean('/path')).toBe('M src/file.ts');
  });

  test('git コマンド失敗 → 空文字列', () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('not a git repo'); });
    expect(checkWorktreeClean('/path')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// appendThreadToConfig
// ---------------------------------------------------------------------------

describe('appendThreadToConfig', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = `/tmp/discord-bridge-test-config-${Date.now()}.json`;
    const config = {
      schemaVersion: 2,
      servers: [{
        name: 'personal',
        discord: { botToken: 'tok', ownerUserId: 'u1' },
        tmux: { session: 'sess' },
        projects: [{
          name: 'proj',
          channelId: 'proj-ch-1',
          projectPath: '/project/path',
          model: 'claude-sonnet-4-6',
        }],
        permissionTools: [],
      }],
    };
    writeFileSync(tmpFile, JSON.stringify(config));
  });

  afterEach(() => {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  });

  test('permission と isolation を保存する', () => {
    appendThreadToConfig('personal', 'proj-ch-1', {
      name: 'my-thread',
      channelId: 'th-ch-99',
      model: 'claude-opus-4-6',
      projectPath: '/project/path',
      permission: 'bypassPermissions',
      isolation: 'worktree',
    }, tmpFile);

    const saved = JSON.parse(readFileSync(tmpFile, 'utf-8'));
    const thread = saved.servers[0].projects[0].threads[0];
    expect(thread.permission).toBe('bypassPermissions');
    expect(thread.isolation).toBe('worktree');
  });

  test('permission/isolation が undefined のときは保存しない', () => {
    appendThreadToConfig('personal', 'proj-ch-1', {
      name: 'plain-thread',
      channelId: 'th-ch-100',
      model: 'claude-sonnet-4-6',
      projectPath: '/project/path',
    }, tmpFile);

    const saved = JSON.parse(readFileSync(tmpFile, 'utf-8'));
    const thread = saved.servers[0].projects[0].threads[0];
    expect(thread.permission).toBeUndefined();
    expect(thread.isolation).toBeUndefined();
  });

  test('inMemoryProject を渡すとメモリ上の threads も同期される', () => {
    const memProject = {
      name: 'proj', channelId: 'proj-ch-1', projectPath: '/project/path',
      model: 'claude-sonnet-4-6', thread: undefined, permissionTools: [] as string[],
      threads: [] as Array<{ name: string; channelId: string; model?: string; startup: boolean }>,
    };
    appendThreadToConfig('personal', 'proj-ch-1', {
      name: 'new-thread',
      channelId: 'th-new',
      model: 'claude-opus-4-6',
      projectPath: '/project/path',
    }, tmpFile, memProject);

    expect(memProject.threads).toHaveLength(1);
    expect(memProject.threads[0]).toEqual({
      name: 'new-thread', channelId: 'th-new', model: 'claude-opus-4-6', startup: false,
    });
  });

  test('inMemoryProject で既存スレッドは上書きマージされる', () => {
    const memProject = {
      name: 'proj', channelId: 'proj-ch-1', projectPath: '/project/path',
      model: 'claude-sonnet-4-6', thread: undefined, permissionTools: [] as string[],
      threads: [{ name: 'old-name', channelId: 'th-exist', startup: true }],
    };
    appendThreadToConfig('personal', 'proj-ch-1', {
      name: 'updated-name',
      channelId: 'th-exist',
      model: 'claude-opus-4-6',
      projectPath: '/project/path',
    }, tmpFile, memProject);

    expect(memProject.threads).toHaveLength(1);
    expect(memProject.threads[0].name).toBe('updated-name');
    expect(memProject.threads[0].model).toBe('claude-opus-4-6');
    // startup は既存値を保持
    expect(memProject.threads[0].startup).toBe(true);
  });

  test('inMemoryProject を渡さない場合はメモリ更新しない（後方互換）', () => {
    appendThreadToConfig('personal', 'proj-ch-1', {
      name: 'thread',
      channelId: 'th-compat',
      model: 'claude-sonnet-4-6',
      projectPath: '/project/path',
    }, tmpFile);
    // ディスクには書き込まれている
    const saved = JSON.parse(readFileSync(tmpFile, 'utf-8'));
    expect(saved.servers[0].projects[0].threads).toHaveLength(1);
    // inMemoryProject が undefined なのでクラッシュしないことが確認できればOK
  });
});

// ---------------------------------------------------------------------------
// autoStartStaticThreads
// ---------------------------------------------------------------------------

const makeAutoStartProject = (
  threads: Array<{ channelId: string; name?: string; startup?: boolean; isolation?: string }> = [],
) => ({
  name: 'proj',
  channelId: 'proj-ch-1',
  projectPath: '/proj',
  model: 'claude-sonnet-4-6',
  thread: undefined,
  permissionTools: [],
  threads: threads.map(t => ({ name: 'thread', startup: false, ...t })),
});

const makeMockStateManager = () => ({
  set: vi.fn(),
  updateWorktreePath: vi.fn(),
  getKnownWorktreePaths: vi.fn().mockReturnValue(new Set<string>()),
  getAll: vi.fn().mockReturnValue(new Map()),
  remove: vi.fn(),
});

describe('autoStartStaticThreads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('startup: true のスレッドを pane 作成して threadPaneMap に登録する', async () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce('%77\n' as unknown as Buffer) // split-window
      .mockReturnValue('' as unknown as Buffer);          // send-keys

    const project = makeAutoStartProject([{ channelId: 'th-startup-1', startup: true }]);
    const threadPaneMap = new Map<string, ThreadPaneInfo>();
    const stateManager = makeMockStateManager();

    await autoStartStaticThreads('sess', [project as never], threadPaneMap, stateManager as never, 'personal');

    expect(threadPaneMap.has('th-startup-1')).toBe(true);
    expect(threadPaneMap.get('th-startup-1')!.paneId).toBe('%77');
    expect(stateManager.set).toHaveBeenCalledWith('th-startup-1', expect.objectContaining({ paneId: '%77' }));
  });

  test('startup: false のスレッドはスキップする', async () => {
    const project = makeAutoStartProject([{ channelId: 'th-no-startup', startup: false }]);
    const threadPaneMap = new Map<string, ThreadPaneInfo>();
    const stateManager = makeMockStateManager();

    await autoStartStaticThreads('sess', [project as never], threadPaneMap, stateManager as never, 'personal');

    expect(threadPaneMap.size).toBe(0);
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
  });

  test('threadPaneMap に既存エントリがある場合はスキップする', async () => {
    const project = makeAutoStartProject([{ channelId: 'th-existing', startup: true }]);
    const threadPaneMap = new Map<string, ThreadPaneInfo>([['th-existing', makeThreadPaneInfo('%00')]]);
    const stateManager = makeMockStateManager();

    await autoStartStaticThreads('sess', [project as never], threadPaneMap, stateManager as never, 'personal');

    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
  });

  test('isolation: worktree のとき worktreePath を非同期で設定する', async () => {
    vi.useFakeTimers();
    const worktreeOutput = [
      'worktree /proj',
      'branch refs/heads/main',
      '',
      'worktree /proj/.claude/worktrees/wt-abc',
      'branch refs/heads/wt-abc',
      '',
    ].join('\n');

    vi.mocked(execFileSync)
      .mockReturnValueOnce('%78\n' as unknown as Buffer) // split-window
      .mockReturnValueOnce('' as unknown as Buffer)       // send-keys
      .mockReturnValue(worktreeOutput as unknown as Buffer); // git worktree list

    const project = makeAutoStartProject([{ channelId: 'th-wt', startup: true, isolation: 'worktree' }]);
    const threadPaneMap = new Map<string, ThreadPaneInfo>();
    const stateManager = makeMockStateManager();

    await autoStartStaticThreads('sess', [project as never], threadPaneMap, stateManager as never, 'personal');

    // バックグラウンド検出はまだ完了していない
    expect(threadPaneMap.get('th-wt')?.worktreePath).toBeUndefined();

    // タイマーを進めて検出を完了させる
    await vi.advanceTimersByTimeAsync(4000);

    expect(threadPaneMap.get('th-wt')?.worktreePath).toBe('/proj/.claude/worktrees/wt-abc');
    expect(stateManager.updateWorktreePath).toHaveBeenCalledWith('th-wt', '/proj/.claude/worktrees/wt-abc');

    vi.useRealTimers();
  });
});

import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
  resolveParentChannel,
  waitForClaudeReady,
  warnDuplicateChannels,
  restoreThreadState,
} from '../src/bot.js';
import { TmuxSender } from '../src/tmux-sender.js';
import type { ThreadPaneInfo } from '../src/thread-state.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// ---------------------------------------------------------------------------
// resolveParentChannel
// ---------------------------------------------------------------------------

describe('resolveParentChannel', () => {
  const channelSenderMap = new Map([
    ['parent-ch-100', new TmuxSender('0:1')],
  ]);

  test('channelId が channelSenderMap に存在 → そのまま返す', () => {
    const result = resolveParentChannel('parent-ch-100', channelSenderMap);
    expect(result).toBe('parent-ch-100');
  });

  test('channelSenderMap になし + threadParentMap にある → threadParentMap の値', () => {
    const threadParentMap = new Map([['thread-abc', 'parent-ch-100']]);
    const result = resolveParentChannel('thread-abc', channelSenderMap, threadParentMap);
    expect(result).toBe('parent-ch-100');
  });

  test('両方なし + channel.isThread() + parentId が channelSenderMap にある → parentId', () => {
    const channel = { isThread: () => true, parentId: 'parent-ch-100' };
    const result = resolveParentChannel('thread-xyz', channelSenderMap, new Map(), channel);
    expect(result).toBe('parent-ch-100');
  });

  test('全部なし → channelId をそのまま返す（フォールバック）', () => {
    const channel = { isThread: () => false, parentId: null };
    const result = resolveParentChannel('unknown-ch', channelSenderMap, new Map(), channel);
    expect(result).toBe('unknown-ch');
  });

  test('channel.isThread() が false → parentId が channelSenderMap にあってもフォールバック', () => {
    const channel = { isThread: () => false, parentId: 'parent-ch-100' };
    const result = resolveParentChannel('thread-not-thread', channelSenderMap, new Map(), channel);
    expect(result).toBe('thread-not-thread');
  });

  test('threadParentMap にあっても channel.isThread() より優先', () => {
    const threadParentMap = new Map([['thread-multi', 'parent-ch-100']]);
    const channel = { isThread: () => true, parentId: 'parent-ch-100' };
    // threadParentMap が先に評価されるので parent-ch-100
    const result = resolveParentChannel('thread-multi', channelSenderMap, threadParentMap, channel);
    expect(result).toBe('parent-ch-100');
  });
});

// ---------------------------------------------------------------------------
// waitForClaudeReady
// ---------------------------------------------------------------------------

describe('waitForClaudeReady', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('Human: が含まれる → すぐに返る', async () => {
    vi.mocked(execFileSync).mockReturnValue('Human: hello\n' as unknown as Buffer);
    const p = waitForClaudeReady('%42', 5000, 100);
    await vi.advanceTimersByTimeAsync(200);
    await expect(p).resolves.toBeUndefined();
    expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(1);
  });

  test('Sonnet が含まれる → すぐに返る', async () => {
    vi.mocked(execFileSync).mockReturnValue('claude-sonnet-4-6 ready\n' as unknown as Buffer);
    const p = waitForClaudeReady('%43', 5000, 100);
    await vi.advanceTimersByTimeAsync(200);
    await expect(p).resolves.toBeUndefined();
  });

  test('✻ が含まれる → すぐに返る', async () => {
    vi.mocked(execFileSync).mockReturnValue('✻ thinking...\n' as unknown as Buffer);
    const p = waitForClaudeReady('%44', 5000, 100);
    await vi.advanceTimersByTimeAsync(200);
    await expect(p).resolves.toBeUndefined();
  });

  test('準備できていない間は繰り返し poll し、タイムアウト後に解決する', async () => {
    // capture-pane は常にClaudeが起動していない内容を返す
    vi.mocked(execFileSync).mockReturnValue('Loading...\n' as unknown as Buffer);
    const p = waitForClaudeReady('%45', 500, 100);
    await vi.advanceTimersByTimeAsync(600);
    await expect(p).resolves.toBeUndefined();
    // 5回以上 poll される（500ms / 100ms = 5回）
    expect(vi.mocked(execFileSync).mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  test('capture-pane が例外をスローしてもエラーにならずタイムアウト後に解決', async () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('pane gone'); });
    const p = waitForClaudeReady('%46', 300, 100);
    await vi.advanceTimersByTimeAsync(400);
    await expect(p).resolves.toBeUndefined();
  });

  test('数回 poll 後に準備完了 → その時点で返る', async () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce('Loading...\n' as unknown as Buffer)
      .mockReturnValueOnce('Still loading...\n' as unknown as Buffer)
      .mockReturnValue('✓ Ready\n' as unknown as Buffer);

    const p = waitForClaudeReady('%47', 5000, 100);
    await vi.advanceTimersByTimeAsync(350); // 3回 poll して3回目で検出
    await expect(p).resolves.toBeUndefined();
    expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// warnDuplicateChannels
// ---------------------------------------------------------------------------

describe('warnDuplicateChannels', () => {
  const makeConfig = (servers: unknown[]) => ({ schemaVersion: 2, servers }) as never;

  const makeProject = (name: string, channelId: string) => ({
    name,
    channelId,
    projectPath: '/path',
    model: 'claude-sonnet-4-6',
    threads: [],
  });

  test('重複なし → console.warn は呼ばれない', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const config = makeConfig([
      { name: 'srv1', projects: [makeProject('proj-a', 'ch-111'), makeProject('proj-b', 'ch-222')] },
    ]);
    warnDuplicateChannels(config);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test('同一 channelId が2プロジェクトにある → console.warn が呼ばれる', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const config = makeConfig([
      {
        name: 'srv1',
        projects: [
          makeProject('proj-a', 'ch-dup'),
          makeProject('proj-b', 'ch-dup'),
        ],
      },
    ]);
    warnDuplicateChannels(config);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0]).toContain('ch-dup');
    warnSpy.mockRestore();
  });

  test('複数サーバーにまたがる重複 → console.warn が呼ばれる', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const config = makeConfig([
      { name: 'srv1', projects: [makeProject('proj-a', 'ch-shared')] },
      { name: 'srv2', projects: [makeProject('proj-b', 'ch-shared')] },
    ]);
    warnDuplicateChannels(config);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// restoreThreadState
// ---------------------------------------------------------------------------

const makeThreadInfo = (overrides: Partial<ThreadPaneInfo> = {}): ThreadPaneInfo => ({
  paneId: '%old-pane',
  paneStartedAt: '2026-01-01T00:00:00Z',
  parentChannelId: 'proj-ch-1',
  projectPath: '/project/path',
  serverName: 'personal',
  createdAt: '2026-01-01T00:00:00Z',
  launchCmd: 'claude',
  ...overrides,
});

const makeServer = () => ({
  name: 'personal',
  discord: { botToken: 'tok', ownerUserId: 'u1' },
  tmux: { session: 'sess' },
  generalChannelId: undefined,
  permissionTools: [],
  projects: [{
    name: 'proj',
    channelId: 'proj-ch-1',
    projectPath: '/project/path',
    model: 'claude-sonnet-4-6',
    threads: [],
    startup: false,
    thread: undefined,
    permissionTools: [],
  }],
}) as never;

const makeMockStateManager = () => ({
  getAll: vi.fn().mockReturnValue(new Map()),
  set: vi.fn(),
  remove: vi.fn(),
  updateWorktreePath: vi.fn(),
  getKnownWorktreePaths: vi.fn().mockReturnValue(new Set<string>()),
});

const makeMockClient = () => ({
  channels: { fetch: vi.fn().mockResolvedValue(null) },
});

describe('restoreThreadState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('serverName が異なるエントリはスキップする', async () => {
    const stateManager = makeMockStateManager();
    stateManager.getAll.mockReturnValue(new Map([
      ['thread-other', makeThreadInfo({ serverName: 'different-server' })],
    ]));
    // git worktree list → 失敗（GCスキップ）
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('not git'); });

    const threadPaneMap = new Map<string, ThreadPaneInfo>();
    await restoreThreadState(makeServer(), stateManager as never, threadPaneMap, makeMockClient() as never);

    expect(threadPaneMap.size).toBe(0);
    expect(stateManager.remove).not.toHaveBeenCalled();
  });

  test('worktree なし + pane なし → stateManager.remove を呼ぶ', async () => {
    const stateManager = makeMockStateManager();
    stateManager.getAll.mockReturnValue(new Map([
      ['thread-gone', makeThreadInfo()], // worktreePath なし
    ]));
    // has-session → 失敗（pane gone）
    vi.mocked(execFileSync)
      .mockImplementationOnce(() => { throw new Error('pane gone'); })  // has-session
      .mockImplementationOnce(() => { throw new Error('not git'); });   // git worktree list GC

    const threadPaneMap = new Map<string, ThreadPaneInfo>();
    await restoreThreadState(makeServer(), stateManager as never, threadPaneMap, makeMockClient() as never);

    expect(stateManager.remove).toHaveBeenCalledWith('thread-gone');
    expect(threadPaneMap.size).toBe(0);
  });

  test('pane あり → threadPaneMap に追加する', async () => {
    const stateManager = makeMockStateManager();
    stateManager.getAll.mockReturnValue(new Map([
      ['thread-alive', makeThreadInfo({ paneId: '%existing-pane' })],
    ]));
    // has-session → 成功（pane alive）
    vi.mocked(execFileSync)
      .mockReturnValueOnce('' as unknown as Buffer)                     // has-session
      .mockImplementationOnce(() => { throw new Error('not git'); });   // git worktree list GC

    const threadPaneMap = new Map<string, ThreadPaneInfo>();
    await restoreThreadState(makeServer(), stateManager as never, threadPaneMap, makeMockClient() as never);

    expect(threadPaneMap.has('thread-alive')).toBe(true);
    expect(threadPaneMap.get('thread-alive')!.paneId).toBe('%existing-pane');
    expect(stateManager.remove).not.toHaveBeenCalled();
  });

  test('worktree あり + pane なし → createThreadPane で復元し threadPaneMap に登録', async () => {
    const stateManager = makeMockStateManager();
    stateManager.getAll.mockReturnValue(new Map([
      ['thread-restore', makeThreadInfo({ worktreePath: '/project/path/.claude/worktrees/wt-abc' })],
    ]));
    vi.mocked(existsSync).mockReturnValueOnce(true);  // worktreeExists
    vi.mocked(execFileSync)
      .mockImplementationOnce(() => { throw new Error('pane gone'); }) // has-session
      .mockReturnValueOnce('%99\n' as unknown as Buffer)               // split-window (createThreadPane)
      .mockReturnValueOnce('' as unknown as Buffer)                    // send-keys
      .mockImplementationOnce(() => { throw new Error('not git'); }); // git worktree list GC

    const threadPaneMap = new Map<string, ThreadPaneInfo>();
    await restoreThreadState(makeServer(), stateManager as never, threadPaneMap, makeMockClient() as never);

    expect(threadPaneMap.has('thread-restore')).toBe(true);
    expect(threadPaneMap.get('thread-restore')!.paneId).toBe('%99');
    expect(stateManager.set).toHaveBeenCalledWith('thread-restore', expect.objectContaining({ paneId: '%99' }));
  });

  test('project が見つからない場合は worktree+pane なしでも createThreadPane を呼ばない', async () => {
    const stateManager = makeMockStateManager();
    stateManager.getAll.mockReturnValue(new Map([
      ['thread-orphan', makeThreadInfo({
        worktreePath: '/project/path/.claude/worktrees/wt-orphan',
        parentChannelId: 'unknown-ch-not-in-projects',
      })],
    ]));
    vi.mocked(existsSync).mockReturnValueOnce(true);  // worktreeExists
    vi.mocked(execFileSync)
      .mockImplementationOnce(() => { throw new Error('pane gone'); }) // has-session
      .mockImplementationOnce(() => { throw new Error('not git'); }); // git worktree list GC

    const threadPaneMap = new Map<string, ThreadPaneInfo>();
    await restoreThreadState(makeServer(), stateManager as never, threadPaneMap, makeMockClient() as never);

    // project が見つからないので createThreadPane は呼ばれない
    const splitWindowCalls = vi.mocked(execFileSync).mock.calls
      .filter(c => Array.isArray(c[1]) && c[1].includes('split-window'));
    expect(splitWindowCalls.length).toBe(0);
    expect(threadPaneMap.size).toBe(0);
  });
});

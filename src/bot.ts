import {
  Client,
  Events,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Message,
  type ButtonInteraction,
} from 'discord.js';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readdir, stat, unlink } from 'node:fs/promises';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { type Config, type Server, type Project, resolveThreadConfig } from './config.js';
import { TmuxSender, escapeTmuxShellArg } from './tmux-sender.js';
import { ThreadStateManager, type ThreadPaneInfo } from './thread-state.js';

const UPLOAD_DIR = '/tmp/discord-uploads';
const DOWNLOAD_TIMEOUT_MS = 30_000;
const DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
const THREAD_TRACKING_DIR = '/tmp';
const DEFAULT_CONFIG_PATH = join(homedir(), '.discord-bridge', 'config.json');

export function writeThreadTracking(parentChannelId: string, threadId: string | null): void {
  const filePath = join(THREAD_TRACKING_DIR, `discord-bridge-thread-${parentChannelId}.json`);
  if (threadId) {
    writeFileSync(filePath, JSON.stringify({ threadId }));
  } else {
    try {
      unlinkSync(filePath);
    } catch { /* ignore if file doesn't exist */ }
  }
}

export function appendThreadToConfig(
  serverName: string,
  projectChannelId: string,
  thread: { name: string; channelId: string; model: string; projectPath: string; permission?: string; isolation?: string },
  configPath: string = DEFAULT_CONFIG_PATH,
): void {
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    const server = raw.servers?.find((s: { name: string }) => s.name === serverName);
    if (!server) return;
    const project = server.projects?.find((p: { channelId: string }) => p.channelId === projectChannelId);
    if (!project) return;
    if (!Array.isArray(project.threads)) project.threads = [];
    const entry: Record<string, unknown> = {
      name: thread.name,
      channelId: thread.channelId,
      model: thread.model,
    };
    if (thread.projectPath !== project.projectPath) entry['projectPath'] = thread.projectPath;
    if (thread.permission !== undefined) entry['permission'] = thread.permission;
    if (thread.isolation !== undefined) entry['isolation'] = thread.isolation;
    const idx = project.threads.findIndex((t: { channelId: string }) => t.channelId === thread.channelId);
    if (idx >= 0) {
      const existing = project.threads[idx];
      project.threads[idx] = existing.startup !== undefined ? { ...entry, startup: existing.startup } : entry;
    } else {
      project.threads.push(entry);
    }
    writeFileSync(configPath, JSON.stringify(raw, null, 2));
  } catch (err) {
    console.error('[discord-bridge] appendThreadToConfig failed:', err);
  }
}

export function buildPermissionFlag(permission?: string): string {
  if (permission === 'bypassPermissions') return ' --dangerously-skip-permissions';
  return '';
}

export function createThreadPane(
  session: string,
  windowName: string,
  projectPath: string,
  model: string,
  threadId: string,
  permission?: string,
  isolation?: string,
): string {
  const paneId = execFileSync('tmux', [
    'split-window', '-t', `${session}:${windowName}`,
    '-d', '-P', '-F', '#{pane_id}',
  ], { encoding: 'utf8' }).trim();

  const permFlag = buildPermissionFlag(permission);
  const worktreeFlag = isolation === 'worktree' ? ' -w' : '';
  const cmd = `export DISCORD_BRIDGE_THREAD_ID=${threadId} && cd "${escapeTmuxShellArg(projectPath)}" && claude --model "${escapeTmuxShellArg(model)}"${permFlag}${worktreeFlag}`;
  execFileSync('tmux', ['send-keys', '-t', paneId, cmd, 'Enter']);

  return paneId;
}

export function killThreadPane(paneId: string): void {
  try {
    execFileSync('tmux', ['kill-pane', '-t', paneId]);
  } catch { /* pane already gone */ }
}

export async function detectWorktreePath(
  projectPath: string,
  knownWorktrees: Set<string>,
  maxRetries: number = 10,
  intervalMs: number = 3000,
): Promise<string | null> {
  for (let i = 0; i < maxRetries; i++) {
    await new Promise(r => setTimeout(r, intervalMs));
    try {
      const output = execFileSync('git', ['-C', projectPath, 'worktree', 'list', '--porcelain'],
        { encoding: 'utf8' });
      const worktrees = output.split('\n\n')
        .filter(block => block.includes('.claude/worktrees/'))
        .map(block => block.match(/^worktree (.+)/m)?.[1])
        .filter((p): p is string => p != null && !knownWorktrees.has(p));
      if (worktrees.length > 0) {
        return worktrees[0] ?? null;
      }
    } catch { /* retry */ }
  }
  return null;
}

export function checkWorktreeClean(worktreePath: string): string {
  try {
    return execFileSync('git', ['-C', worktreePath, 'status', '--porcelain'],
      { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

// Claude Code が起動して入力待ち状態になるまでポーリングで待機する
// tmux capture-pane の出力に Claude UI の特徴的なテキストが現れたら準備完了と判断する
export async function waitForClaudeReady(
  paneId: string,
  timeoutMs = 15000,
  pollIntervalMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise<void>(r => setTimeout(r, pollIntervalMs));
    try {
      const content = execFileSync('tmux', ['capture-pane', '-p', '-t', paneId], { encoding: 'utf8' });
      // Claude Code が起動するとステータスバーにモデル名や UI 要素が表示される
      if (
        content.includes('Human:') ||
        /Sonnet|Opus|Haiku/i.test(content) ||
        content.includes('✻') ||
        content.includes('✓')
      ) {
        return;
      }
    } catch { /* pane がまだ準備できていない場合は無視 */ }
  }
  // タイムアウト: ブロックを避けるためそのまま続行
}

export function listRunningWindows(session: string): Set<string> {
  try {
    const output = execFileSync('tmux', ['list-windows', '-t', session, '-F', '#{window_name}'],
      { encoding: 'utf8' });
    return new Set(output.trim().split('\n').filter(Boolean));
  } catch {
    return new Set();
  }
}

export function startProjectWindow(session: string, project: Project): void {
  execFileSync('tmux', ['new-window', '-t', session, '-n', project.name, '-d']);
  const cmd = `cd "${escapeTmuxShellArg(project.projectPath)}" && claude --model "${escapeTmuxShellArg(project.model)}"`;
  execFileSync('tmux', ['send-keys', '-t', `${session}:${project.name}`, cmd, 'Enter']);
}

export function stopProjectWindow(session: string, windowName: string): void {
  execFileSync('tmux', ['kill-window', '-t', `${session}:${windowName}`]);
}

export function autoStartProjects(session: string, projects: Project[]): void {
  const running = listRunningWindows(session);
  for (const project of projects) {
    if (project.startup && !running.has(project.name)) {
      try {
        startProjectWindow(session, project);
      } catch (err) {
        console.error(`[discord-bridge] Failed to auto-start project "${project.name}":`, err);
      }
    } else if (!project.startup && running.has(project.name)) {
      try {
        stopProjectWindow(session, project.name);
      } catch (err) {
        console.error(`[discord-bridge] Failed to stop project "${project.name}":`, err);
      }
    }
  }
}

export async function autoStartStaticThreads(
  session: string,
  projects: Project[],
  threadPaneMap: Map<string, ThreadPaneInfo>,
  stateManager: ThreadStateManager,
  serverName: string,
): Promise<void> {
  for (const project of projects) {
    const startupThreads = project.threads.filter(t => t.startup);
    for (const thread of startupThreads) {
      if (threadPaneMap.has(thread.channelId)) continue;
      try {
        const resolved = resolveThreadConfig(project, thread.channelId);
        const paneId = createThreadPane(
          session, project.name, resolved.projectPath,
          resolved.model, thread.channelId,
          resolved.permission,
          resolved.isolation,
        );
        const now = new Date().toISOString();
        const permFlag = buildPermissionFlag(resolved.permission);
        const worktreeFlag = resolved.isolation === 'worktree' ? ' -w' : '';
        const launchCmd = `export DISCORD_BRIDGE_THREAD_ID=${thread.channelId} && cd "${escapeTmuxShellArg(resolved.projectPath)}" && claude --model "${escapeTmuxShellArg(resolved.model)}"${permFlag}${worktreeFlag}`;
        const info: ThreadPaneInfo = {
          paneId,
          paneStartedAt: now,
          parentChannelId: project.channelId,
          projectPath: resolved.projectPath,
          serverName,
          createdAt: now,
          launchCmd,
        };
        threadPaneMap.set(thread.channelId, info);
        stateManager.set(thread.channelId, info);

        // worktree パス検出 (バックグラウンド)
        if (resolved.isolation === 'worktree') {
          const channelId = thread.channelId;
          const knownFromState = stateManager.getKnownWorktreePaths();
          const knownFromMap = [...threadPaneMap.values()]
            .filter(i => i.worktreePath)
            .map(i => i.worktreePath!);
          const knownPaths = new Set([...knownFromState, ...knownFromMap]);
          void detectWorktreePath(resolved.projectPath, knownPaths)
            .then(wtPath => {
              if (wtPath) {
                const current = threadPaneMap.get(channelId);
                if (current) current.worktreePath = wtPath;
                stateManager.updateWorktreePath(channelId, wtPath);
              }
            });
        }
      } catch (err) {
        console.error(`[discord-bridge] Failed to auto-start static thread "${thread.channelId}":`, err);
      }
    }
  }
}

// Discord limit: 5 rows × 5 buttons = 25 total. Reserve 1 slot for Refresh.
const MAX_PROJECT_BUTTONS = 24;

export function buildControlPanel(
  session: string,
  projects: Project[],
  stateManager: ThreadStateManager,
  serverName: string,
): { content: string; components: ActionRowBuilder<ButtonBuilder>[] } {
  const running = listRunningWindows(session);
  const cappedProjects = projects.slice(0, MAX_PROJECT_BUTTONS);

  const lines: string[] = ['🎮 **Control Panel**', '', '**Projects**'];
  for (const project of cappedProjects) {
    const isRunning = running.has(project.name);
    lines.push(`${isRunning ? '🟢' : '⭕'} \`${project.name}\` — ${isRunning ? 'running' : 'stopped'}`);
  }
  if (projects.length > MAX_PROJECT_BUTTONS) {
    lines.push(`_… and ${projects.length - MAX_PROJECT_BUTTONS} more (not shown)_`);
  }

  const allThreads = stateManager.getAll();
  const worktrees = [...allThreads.entries()]
    .filter(([, info]) => info.worktreePath && info.serverName === serverName)
    .map(([threadId, info]) => `• Thread ${threadId.slice(0, 6)}... → ${info.worktreePath}`);
  if (worktrees.length > 0) {
    lines.push('', '**Active Worktrees**');
    lines.push(...worktrees);
  }

  const now = new Date().toISOString().replace('T', ' ').slice(0, 16);
  lines.push('', `_Updated: ${now}_`);
  const content = lines.join('\n');

  const buttons: ButtonBuilder[] = [];
  for (const project of cappedProjects) {
    const isRunning = running.has(project.name);
    buttons.push(
      new ButtonBuilder()
        .setCustomId(isRunning ? `ctrl:stop:${project.name}` : `ctrl:start:${project.name}`)
        .setLabel(isRunning ? `🛑 Stop ${project.name}` : `▶ Start ${project.name}`)
        .setStyle(isRunning ? ButtonStyle.Danger : ButtonStyle.Success),
    );
  }
  buttons.push(
    new ButtonBuilder()
      .setCustomId('ctrl:refresh')
      .setLabel('🔄 Refresh')
      .setStyle(ButtonStyle.Secondary),
  );

  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length; i += 5) {
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5)));
  }

  return { content, components };
}

async function handleControlInteraction(
  interaction: ButtonInteraction,
  server: Server,
  session: string,
  stateManager: ThreadStateManager,
): Promise<void> {
  if (interaction.user.id !== server.discord.ownerUserId) {
    await interaction.reply({ content: 'Unauthorized', ephemeral: true });
    return;
  }

  const customId = interaction.customId;

  if (customId === 'ctrl:refresh') {
    const panel = buildControlPanel(session, server.projects, stateManager, server.name);
    await interaction.update(panel);
    return;
  }

  if (customId.startsWith('ctrl:start:')) {
    const name = customId.slice('ctrl:start:'.length);
    const project = server.projects.find(p => p.name === name);
    if (project && !listRunningWindows(session).has(project.name)) {
      try {
        startProjectWindow(session, project);
      } catch (err) {
        console.error('[discord-bridge] Failed to start project window:', err);
      }
    }
    const panel = buildControlPanel(session, server.projects, stateManager, server.name);
    await interaction.update(panel);
    return;
  }

  if (customId.startsWith('ctrl:stop:')) {
    const name = customId.slice('ctrl:stop:'.length);
    try {
      stopProjectWindow(session, name);
    } catch (err) {
      console.error('[discord-bridge] Failed to stop project window:', err);
    }
    const panel = buildControlPanel(session, server.projects, stateManager, server.name);
    await interaction.update(panel);
  }
}

export function buildMessageWithAttachments(content: string, paths: string[]): string {
  if (paths.length === 0) return content;
  const pathLines = paths.map((p) => `[attachment: ${p}]`).join('\n');
  return content ? `${content}\n${pathLines}` : pathLines;
}

export async function downloadAttachment(url: string, name: string): Promise<string> {
  await mkdir(UPLOAD_DIR, { recursive: true });
  const safeName = basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
  const uniqueId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const dest = join(UPLOAD_DIR, `${uniqueId}_${safeName}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Failed to download attachment: ${response.status} ${response.statusText}`);
    }
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > DOWNLOAD_MAX_BYTES) {
      throw new Error(`Attachment too large: ${contentLength} bytes (max ${DOWNLOAD_MAX_BYTES})`);
    }
    if (!response.body) {
      throw new Error('Response body is null');
    }
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > DOWNLOAD_MAX_BYTES) {
          reader.cancel().catch(() => { /* ignore */ });
          throw new Error(`Attachment too large: exceeded ${DOWNLOAD_MAX_BYTES} bytes (max ${DOWNLOAD_MAX_BYTES})`);
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    await writeFile(dest, Buffer.concat(chunks));
    return dest;
  } finally {
    clearTimeout(timer);
  }
}

export function resolveParentChannel(
  channelId: string,
  channelSenderMap: Map<string, TmuxSender>,
  threadParentMap?: Map<string, string>,
  channel?: { isThread(): boolean; parentId?: string | null } | null,
): string {
  if (channelSenderMap.has(channelId)) return channelId;
  const fromMap = threadParentMap?.get(channelId);
  if (fromMap) return fromMap;
  // Bot 再起動後 threadParentMap が消失しても channel オブジェクトから解決
  if (channel?.isThread() && channel.parentId && channelSenderMap.has(channel.parentId)) {
    return channel.parentId;
  }
  return channelId;
}

export async function handleInteractionCreate(
  interaction: { isButton(): boolean },
  ownerUserId: string,
  channelSenderMap: Map<string, TmuxSender>,
  defaultSender: TmuxSender,
  threadParentMap?: Map<string, string>,
  threadPaneMap?: Map<string, string | ThreadPaneInfo>,
): Promise<void> {
  if (!interaction.isButton()) return;
  const btn = interaction as ButtonInteraction;
  if (btn.user.id !== ownerUserId) {
    await btn.reply({ content: 'Unauthorized', ephemeral: true });
    return;
  }
  if (btn.customId === '__other__') {
    try {
      await btn.update({ content: btn.message.content, components: [] });
      await btn.followUp({ content: '📝 回答を入力してください' });
    } catch { /* ignore */ }
    return;
  }

  // perm: prefix → file-based IPC for permission hooks
  if (btn.customId.startsWith('perm:')) {
    // channelId はDiscord Snowflake (数字のみ) であるべき
    if (!/^\d+$/.test(btn.channelId)) return;

    // スレッド内ボタンの場合、親チャンネルIDを解決
    const resolvedChannelId = resolveParentChannel(btn.channelId, channelSenderMap, threadParentMap, btn.channel);

    const action = btn.customId.slice(5); // "allow" | "deny" | "other"
    const respPath = `/tmp/discord-bridge-perm-${resolvedChannelId}.json`;

    if (action === 'other') {
      try {
        writeFileSync(respPath, JSON.stringify({ decision: 'block' }));
      } catch (err) {
        console.error('[discord-bridge] Failed to write permission response:', err);
      }
      try {
        await btn.reply({ content: '📝 Please enter your reason', ephemeral: false });
      } catch { /* ignore */ }
      return;
    }

    const decision = action === 'allow' ? 'allow' : 'deny';
    try {
      writeFileSync(respPath, JSON.stringify({ decision }));
    } catch (err) {
      console.error('[discord-bridge] Failed to write permission response:', err);
    }

    try {
      await btn.reply({
        content: decision === 'allow' ? '✅ Allowed' : '❌ Denied',
        ephemeral: false,
      });
    } catch { /* ignore */ }
    return;
  }
  const resolvedBtnChannelId = resolveParentChannel(btn.channelId, channelSenderMap, threadParentMap, btn.channel);
  const label = btn.customId.includes(':') ? btn.customId.split(':').slice(1).join(':') : btn.customId;
  let sent = false;
  try {
    handleButtonInteraction(resolvedBtnChannelId, btn.customId, channelSenderMap, defaultSender, btn.channelId, threadPaneMap);
    sent = true;
  } catch (err) {
    console.error('[discord-bridge] Failed to handle button interaction:', err);
  }
  try {
    const status = sent ? `✅ 選択: ${label}` : `❌ 送信失敗: ${label}`;
    await btn.update({ content: `${btn.message.content}\n\n${status}`, components: [] });
  } catch { /* ignore update failure */ }
}

export function handleButtonInteraction(
  channelId: string,
  customId: string,
  channelSenderMap: Map<string, TmuxSender>,
  defaultSender: TmuxSender,
  originalChannelId?: string,
  threadPaneMap?: Map<string, string | ThreadPaneInfo>,
): void {
  const entry = originalChannelId ? threadPaneMap?.get(originalChannelId) : undefined;
  const paneTarget = typeof entry === 'string' ? entry : entry?.paneId;
  const sender = paneTarget ? new TmuxSender(paneTarget) : (channelSenderMap.get(channelId) ?? defaultSender);
  sender.send(customId.includes(':') ? customId.split(':').slice(1).join(':') : customId);
}

async function cleanUploadDir(): Promise<void> {
  const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();
  try {
    const files = await readdir(UPLOAD_DIR);
    await Promise.all(files.map(async (file) => {
      try {
        const filePath = join(UPLOAD_DIR, file);
        const fileStat = await stat(filePath);
        if (now - fileStat.mtimeMs > TWENTY_FOUR_HOURS_MS) {
          await unlink(filePath);
        }
      } catch { /* ignore per-file errors */ }
    }));
  } catch { /* ignore if dir does not exist */ }
}

export function createServerBot(server: Server): Client {
  void cleanUploadDir();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  const session = server.tmux.session;
  const defaultSender = new TmuxSender(`${session}:0`);

  const channelSenderMap = new Map<string, TmuxSender>();
  for (const project of server.projects) {
    const target = `${session}:${project.name}`;
    channelSenderMap.set(project.channelId, new TmuxSender(target));
  }

  const listenChannelIds = new Set(server.projects.map((p) => p.channelId));
  const threadParentMap = new Map<string, string>(); // threadId → parentChannelId
  const threadPaneMap = new Map<string, ThreadPaneInfo>(); // threadId → ThreadPaneInfo
  const stateManager = new ThreadStateManager(
    join(homedir(), '.discord-bridge', 'thread-state.json')
  );
  const threadPaneCreating = new Set<string>(); // race condition 防止

  client.once(Events.ClientReady, async (c) => {
    console.log(`[discord-bridge] Bot ready: ${c.user.tag}`);

    // 永続化された スレッドペイン / worktree 状態を復元
    await restoreThreadState(server, stateManager, threadPaneMap, client);

    // startup: true のプロジェクトを自動起動
    autoStartProjects(session, server.projects);

    // startup: true のスレッドを自動起動
    await autoStartStaticThreads(session, server.projects, threadPaneMap, stateManager, server.name);

    if (server.generalChannelId) {
      try {
        const ch = await c.channels.fetch(server.generalChannelId);
        if (ch?.isSendable()) {
          const panel = buildControlPanel(session, server.projects, stateManager, server.name);
          await ch.send(panel);
        }
      } catch (err) {
        console.error('[discord-bridge] Failed to send control panel to general channel:', err);
      }
    }
  });

  client.on(Events.MessageCreate, async (msg: Message) => {
    if (msg.author.bot) return;
    if (msg.author.id !== server.discord.ownerUserId) return;

    // general チャンネルへのメッセージはステータス更新のみ（tmux には送らない）
    if (server.generalChannelId && msg.channelId === server.generalChannelId) {
      const panel = buildControlPanel(session, server.projects, stateManager, server.name);
      await msg.reply(panel);
      return;
    }

    let parentChannelId: string;
    let trySend: (text: string) => void;
    let newThreadPaneId: string | null = null;

    if (listenChannelIds.has(msg.channelId)) {
      parentChannelId = msg.channelId;
      writeThreadTracking(parentChannelId, null); // 親チャンネルに戻った
      const sender = channelSenderMap.get(parentChannelId) ?? defaultSender;
      trySend = (text: string): void => {
        try { sender.send(text); } catch (err) {
          console.error(`[discord-bridge] Failed to send to tmux in channel ${msg.channelId}:`, err);
        }
      };
    } else if (msg.channel.isThread() && msg.channel.parentId && listenChannelIds.has(msg.channel.parentId)) {
      parentChannelId = msg.channel.parentId;
      threadParentMap.set(msg.channelId, parentChannelId);

      if (threadPaneMap.has(msg.channelId)) {
        // 既存 pane にルーティング
        writeThreadTracking(parentChannelId, msg.channelId);
        const paneTarget = threadPaneMap.get(msg.channelId)!.paneId;
        const paneSender = new TmuxSender(paneTarget);
        trySend = (text: string): void => {
          try { paneSender.send(text); } catch (err) {
            console.error(`[discord-bridge] Pane send failed, removing stale entry:`, err);
            threadPaneMap.delete(msg.channelId);
            writeThreadTracking(parentChannelId, msg.channelId);
            const fallbackSender = channelSenderMap.get(parentChannelId) ?? defaultSender;
            try { fallbackSender.send(text); } catch { /* ignore */ }
          }
        };
      } else if (threadPaneCreating.has(msg.channelId)) {
        // 作成中 → 親 pane にフォールバック
        writeThreadTracking(parentChannelId, msg.channelId);
        const sender = channelSenderMap.get(parentChannelId) ?? defaultSender;
        trySend = (text: string): void => {
          try { sender.send(text); } catch (err) {
            console.error(`[discord-bridge] Failed to send to tmux in channel ${msg.channelId}:`, err);
          }
        };
      } else {
        // 新規 pane 作成
        const project = server.projects.find((p) => p.channelId === parentChannelId);
        if (project) {
          threadPaneCreating.add(msg.channelId);
          try {
            const resolved = resolveThreadConfig(project, msg.channelId);
            const paneId = createThreadPane(
              session, project.name, resolved.projectPath,
              resolved.model,
              msg.channelId,
              resolved.permission,
              resolved.isolation,
            );
            const now = new Date().toISOString();
            const permFlag = buildPermissionFlag(resolved.permission);
            const worktreeFlag = resolved.isolation === 'worktree' ? ' -w' : '';
            const launchCmd = `export DISCORD_BRIDGE_THREAD_ID=${msg.channelId} && cd "${escapeTmuxShellArg(resolved.projectPath)}" && claude --model "${escapeTmuxShellArg(resolved.model)}"${permFlag}${worktreeFlag}`;
            const info: ThreadPaneInfo = {
              paneId,
              paneStartedAt: now,
              parentChannelId,
              projectPath: resolved.projectPath,
              serverName: server.name,
              createdAt: now,
              launchCmd,
            };
            threadPaneMap.set(msg.channelId, info);
            stateManager.set(msg.channelId, info);
            const threadName = msg.channel.isThread() ? msg.channel.name : msg.channelId;
            appendThreadToConfig(server.name, parentChannelId, {
              name: threadName,
              channelId: msg.channelId,
              model: resolved.model,
              projectPath: resolved.projectPath,
              permission: resolved.permission,
              isolation: resolved.isolation,
            });

            // worktree パス検出 (バックグラウンド)
            // stateManager + threadPaneMap の両方から最新の既知パスを収集し、
            // 複数スレッド同時作成時の誤マッピングを防止する
            if (resolved.isolation === 'worktree') {
              const knownFromState = stateManager.getKnownWorktreePaths();
              const knownFromMap = [...threadPaneMap.values()]
                .filter(i => i.worktreePath)
                .map(i => i.worktreePath!);
              const knownPaths = new Set([...knownFromState, ...knownFromMap]);
              void detectWorktreePath(resolved.projectPath, knownPaths)
                .then(wtPath => {
                  if (wtPath) {
                    const current = threadPaneMap.get(msg.channelId);
                    if (current) current.worktreePath = wtPath;
                    stateManager.updateWorktreePath(msg.channelId, wtPath);
                  }
                });
            }

            newThreadPaneId = paneId;
            const paneSender = new TmuxSender(paneId);
            trySend = (text: string): void => {
              try { paneSender.send(text); } catch (err) {
                console.error(`[discord-bridge] Pane send failed, removing stale entry:`, err);
                threadPaneMap.delete(msg.channelId);
                writeThreadTracking(parentChannelId, msg.channelId);
                const fallbackSender = channelSenderMap.get(parentChannelId) ?? defaultSender;
                try { fallbackSender.send(text); } catch { /* ignore */ }
              }
            };
          } catch (err) {
            console.error(`[discord-bridge] Failed to create thread pane:`, err);
            // pane 作成失敗 → 親 pane にフォールバック（v1.6 動作）
            writeThreadTracking(parentChannelId, msg.channelId);
            const sender = channelSenderMap.get(parentChannelId) ?? defaultSender;
            trySend = (text: string): void => {
              try { sender.send(text); } catch (e) {
                console.error(`[discord-bridge] Failed to send to tmux in channel ${msg.channelId}:`, e);
              }
            };
          } finally {
            threadPaneCreating.delete(msg.channelId);
          }
        } else {
          // project が見つからない → 親 pane にフォールバック
          writeThreadTracking(parentChannelId, msg.channelId);
          const sender = channelSenderMap.get(parentChannelId) ?? defaultSender;
          trySend = (text: string): void => {
            try { sender.send(text); } catch (err) {
              console.error(`[discord-bridge] Failed to send to tmux in channel ${msg.channelId}:`, err);
            }
          };
        }
      }
    } else {
      return;
    }

    // 新規 pane 作成時: Claude が起動して入力待ち状態になるまで待機
    if (newThreadPaneId !== null) {
      await waitForClaudeReady(newThreadPaneId);
    }

    if (msg.attachments.size > 0) {
      try {
        const paths = await Promise.all(
          [...msg.attachments.values()].map((a) => downloadAttachment(a.url, a.name)),
        );
        trySend(buildMessageWithAttachments(msg.content, paths));
      } catch (err) {
        console.error(`[discord-bridge] Failed to download attachment in channel ${msg.channelId}:`, err);
        try {
          await msg.reply('Failed to download attachment. Sending message text only.');
        } catch { /* ignore reply failure */ }
        trySend(msg.content);
      }
    } else {
      trySend(msg.content);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isButton() && interaction.customId.startsWith('ctrl:')) {
      await handleControlInteraction(interaction, server, session, stateManager);
      return;
    }
    await handleInteractionCreate(interaction, server.discord.ownerUserId, channelSenderMap, defaultSender, threadParentMap, threadPaneMap);
  });

  client.on(Events.ThreadUpdate, async (_oldThread, newThread) => {
    if (newThread.archived && threadPaneMap.has(newThread.id)) {
      const info = threadPaneMap.get(newThread.id)!;
      killThreadPane(info.paneId);
      if (info.worktreePath) {
        const dirtyStatus = checkWorktreeClean(info.worktreePath);
        if (dirtyStatus) {
          try {
            const channel = await newThread.client.channels.fetch(info.parentChannelId);
            if (channel?.isSendable()) {
              await channel.send(`⚠️ スレッド worktree に未コミット変更があります:\n\`\`\`\n${dirtyStatus}\n\`\`\`\nworktree を強制削除します。`);
            }
          } catch { /* ignore */ }
        }
        try {
          execFileSync('git', ['-C', info.projectPath, 'worktree', 'remove', info.worktreePath, '--force']);
        } catch { /* already removed */ }
      }
      threadPaneMap.delete(newThread.id);
      stateManager.remove(newThread.id);
    }
  });

  // worktree 消失ポーリング (30秒間隔)
  setInterval(async () => {
    for (const [threadId, info] of threadPaneMap) {
      if (info.worktreePath && !existsSync(info.worktreePath)) {
        try {
          const channel = await client.channels.fetch(threadId);
          if (channel?.isSendable()) {
            await channel.send('✅ worktree remove 完了。スレッドをアーカイブしてください。');
          }
        } catch { /* ignore */ }
        info.worktreePath = undefined;
        stateManager.updateWorktreePath(threadId, '');
      }
    }
  }, 30_000);

  return client;
}

export async function startServerBot(server: Server): Promise<Client> {
  const client = createServerBot(server);
  await client.login(server.discord.botToken);
  return client;
}

export function warnDuplicateChannels(config: Config): void {
  const seen = new Map<string, string>();
  for (const server of config.servers) {
    for (const project of server.projects) {
      const existing = seen.get(project.channelId);
      if (existing) {
        console.warn(
          `[discord-bridge] Warning: channelId "${project.channelId}" shared between "${existing}" and "${server.name}/${project.name}"`,
        );
      } else {
        seen.set(project.channelId, `${server.name}/${project.name}`);
      }
    }
  }
}

export async function restoreThreadState(
  server: Server,
  stateManager: ThreadStateManager,
  threadPaneMap: Map<string, ThreadPaneInfo>,
  client: Client,
): Promise<void> {
  const session = server.tmux.session;
  const allEntries = stateManager.getAll();
  const restored: string[] = [];
  const cleaned: string[] = [];

  for (const [threadId, info] of allEntries) {
    if (info.serverName !== server.name) continue;

    const worktreeExists = info.worktreePath ? existsSync(info.worktreePath) : false;
    let paneExists = false;
    try {
      execFileSync('tmux', ['has-session', '-t', info.paneId]);
      paneExists = true;
    } catch { /* pane gone */ }

    if (worktreeExists && !paneExists) {
      // worktree あり + ペインなし → 復元
      const project = server.projects.find(p => p.channelId === info.parentChannelId);
      if (project) {
        try {
          const resolved = resolveThreadConfig(project, threadId);
          const paneId = createThreadPane(
            session, project.name, info.projectPath,
            resolved.model,
            threadId,
            resolved.permission,
            resolved.isolation,
          );
          info.paneId = paneId;
          info.paneStartedAt = new Date().toISOString();
          threadPaneMap.set(threadId, info);
          stateManager.set(threadId, info);
          restored.push(threadId);
        } catch (err) {
          console.error(`[discord-bridge] Failed to restore thread pane ${threadId}:`, err);
        }
      }
    } else if (!worktreeExists && !paneExists) {
      // 両方なし → クリーンアップ
      stateManager.remove(threadId);
      cleaned.push(threadId);
    } else if (paneExists) {
      // ペインあり（worktree の有無に関わらず）→ threadPaneMap に復元
      threadPaneMap.set(threadId, info);
    }
  }

  // 孤立 worktree GC
  const orphaned: string[] = [];
  for (const project of server.projects) {
    try {
      const output = execFileSync('git', ['-C', project.projectPath, 'worktree', 'list', '--porcelain'],
        { encoding: 'utf8' });
      const worktrees = output.split('\n\n')
        .filter(block => block.includes('.claude/worktrees/'))
        .map(block => block.match(/^worktree (.+)/m)?.[1])
        .filter(Boolean) as string[];
      const known = stateManager.getKnownWorktreePaths();
      for (const wt of worktrees) {
        if (!known.has(wt)) orphaned.push(wt);
      }
    } catch { /* git command failed */ }
  }

  // 復元結果を通知
  if (restored.length > 0 || orphaned.length > 0) {
    const fallbackProject = server.projects[0];
    try {
      const channel = await client.channels.fetch(fallbackProject.channelId);
      if (channel?.isSendable()) {
        const parts: string[] = [];
        if (restored.length > 0) {
          parts.push(`🔄 再起動後に${restored.length}件のスレッド worktree を復元しました`);
        }
        if (orphaned.length > 0) {
          parts.push(`⚠️ 孤立 worktree を検出:\n${orphaned.map(p => `  - ${p}`).join('\n')}`);
        }
        await channel.send(parts.join('\n'));
      }
    } catch { /* ignore */ }
  }
}

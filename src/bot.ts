import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  type ButtonInteraction,
} from 'discord.js';
import { mkdir, writeFile, readdir, stat, unlink } from 'node:fs/promises';
import { writeFileSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { type Config, type Server } from './config.js';
import { TmuxSender } from './tmux-sender.js';

const UPLOAD_DIR = '/tmp/discord-uploads';
const DOWNLOAD_TIMEOUT_MS = 30_000;
const DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
const THREAD_TRACKING_DIR = '/tmp';

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

export function buildMessageWithAttachments(content: string, paths: string[]): string {
  if (paths.length === 0) return content;
  const pathLines = paths.map((p) => `[添付: ${p}]`).join('\n');
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
): Promise<void> {
  if (!interaction.isButton()) return;
  const btn = interaction as ButtonInteraction;
  if (btn.user.id !== ownerUserId) {
    await btn.reply({ content: 'Unauthorized', ephemeral: true });
    return;
  }
  if (btn.customId === '__other__') {
    try {
      await btn.reply({ content: '📝 回答を入力してください', ephemeral: false });
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
        await btn.reply({ content: '📝 理由を入力してください', ephemeral: false });
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
        content: decision === 'allow' ? '✅ 許可しました' : '❌ 拒否しました',
        ephemeral: false,
      });
    } catch { /* ignore */ }
    return;
  }
  const resolvedBtnChannelId = resolveParentChannel(btn.channelId, channelSenderMap, threadParentMap, btn.channel);
  let sent = false;
  try {
    handleButtonInteraction(resolvedBtnChannelId, btn.customId, channelSenderMap, defaultSender);
    sent = true;
  } catch (err) {
    console.error('[discord-bridge] Failed to handle button interaction:', err);
  }
  try {
    const label = btn.customId.includes(':') ? btn.customId.split(':').slice(1).join(':') : btn.customId;
    const replyContent = sent ? `✅ 選択: ${label}` : '❌ 送信に失敗しました';
    await btn.reply({ content: replyContent, ephemeral: true });
  } catch { /* ignore reply failure */ }
}

export function handleButtonInteraction(
  channelId: string,
  customId: string,
  channelSenderMap: Map<string, TmuxSender>,
  defaultSender: TmuxSender,
): void {
  const sender = channelSenderMap.get(channelId) ?? defaultSender;
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

  client.once(Events.ClientReady, async (c) => {
    console.log(`[discord-bridge] Bot ready: ${c.user.tag}`);
    let isFirst = true;
    for (const project of server.projects) {
      if (!isFirst) await new Promise<void>((resolve) => { setTimeout(resolve, 1000); });
      isFirst = false;
      try {
        const channel = await c.channels.fetch(project.channelId);
        if (channel?.isSendable()) {
          await channel.send('🟢 Bot 起動');
        }
      } catch (err) {
        console.error(`[discord-bridge] Failed to send ready message to ${project.channelId}:`, err);
      }
    }
  });

  client.on(Events.MessageCreate, async (msg: Message) => {
    if (msg.author.bot) return;
    if (msg.author.id !== server.discord.ownerUserId) return;

    let parentChannelId: string;
    if (listenChannelIds.has(msg.channelId)) {
      parentChannelId = msg.channelId;
      writeThreadTracking(parentChannelId, null); // 親チャンネルに戻った
    } else if (msg.channel.isThread() && msg.channel.parentId && listenChannelIds.has(msg.channel.parentId)) {
      parentChannelId = msg.channel.parentId;
      writeThreadTracking(parentChannelId, msg.channelId); // スレッドを追跡
      threadParentMap.set(msg.channelId, parentChannelId);
    } else {
      return;
    }
    const sender = channelSenderMap.get(parentChannelId) ?? defaultSender;

    const trySend = (text: string): void => {
      try {
        sender.send(text);
      } catch (err) {
        console.error(`[discord-bridge] Failed to send to tmux in channel ${msg.channelId}:`, err);
      }
    };

    if (msg.attachments.size > 0) {
      try {
        const paths = await Promise.all(
          [...msg.attachments.values()].map((a) => downloadAttachment(a.url, a.name)),
        );
        trySend(buildMessageWithAttachments(msg.content, paths));
      } catch (err) {
        console.error(`[discord-bridge] Failed to download attachment in channel ${msg.channelId}:`, err);
        try {
          await msg.reply('添付ファイルのダウンロードに失敗しました。メッセージ本文のみ送信しました。');
        } catch { /* ignore reply failure */ }
        trySend(msg.content);
      }
    } else {
      trySend(msg.content);
    }
  });

  client.on(Events.InteractionCreate, (interaction) =>
    handleInteractionCreate(interaction, server.discord.ownerUserId, channelSenderMap, defaultSender, threadParentMap),
  );

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

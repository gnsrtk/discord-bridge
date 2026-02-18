import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildMessageWithAttachments, downloadAttachment } from '../src/bot.js';

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

describe('buildMessageWithAttachments', () => {
  test('テキストと添付パスを結合する', () => {
    const result = buildMessageWithAttachments('確認して', ['/tmp/discord-uploads/123_photo.png']);
    expect(result).toBe('確認して\n[添付: /tmp/discord-uploads/123_photo.png]');
  });

  test('添付が複数ある場合', () => {
    const result = buildMessageWithAttachments('2ファイル', ['/tmp/a.txt', '/tmp/b.py']);
    expect(result).toBe('2ファイル\n[添付: /tmp/a.txt]\n[添付: /tmp/b.py]');
  });

  test('テキストなし・添付のみの場合', () => {
    const result = buildMessageWithAttachments('', ['/tmp/file.pdf']);
    expect(result).toBe('[添付: /tmp/file.pdf]');
  });

  test('添付なしの場合はテキストのみ返す', () => {
    const result = buildMessageWithAttachments('hello', []);
    expect(result).toBe('hello');
  });
});

describe('downloadAttachment', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  test('fetch が ok:false (404) を返した場合に例外をスローする', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });
    await expect(downloadAttachment('https://example.com/file.png', 'file.png')).rejects.toThrow();
  });

  test('fetch が ok:false (403) を返した場合にエラーメッセージに status と statusText が含まれる', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden' });
    await expect(downloadAttachment('https://example.com/file.png', 'file.png')).rejects.toThrow(
      /403.*Forbidden/,
    );
  });

  const makeOkResponse = (buffer: ArrayBuffer) => {
    const uint8 = new Uint8Array(buffer);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(uint8);
        controller.close();
      },
    });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
      body: stream,
    };
  };

  test('fetch が ok:true を返した場合、writeFile が呼ばれてパスが返される', async () => {
    const fakeBuffer = new ArrayBuffer(4);
    fetchMock.mockResolvedValue(makeOkResponse(fakeBuffer));

    const { writeFile } = await import('node:fs/promises');
    const result = await downloadAttachment('https://example.com/photo.png', 'photo.png');

    expect(writeFile).toHaveBeenCalledOnce();
    expect(result).toMatch(/^\/tmp\/discord-uploads\/\d+_[a-z0-9]+_photo\.png$/);
  });

  test('ファイル名に ../ が含まれる場合、basename でサニタイズされる', async () => {
    const fakeBuffer = new ArrayBuffer(4);
    fetchMock.mockResolvedValue(makeOkResponse(fakeBuffer));

    const result = await downloadAttachment('https://example.com/file', '../../etc/passwd');

    expect(result).toMatch(/passwd$/);
    expect(result).not.toContain('..');
  });

  test('ファイル名に特殊文字が含まれる場合、_ に置換される', async () => {
    const fakeBuffer = new ArrayBuffer(4);
    fetchMock.mockResolvedValue(makeOkResponse(fakeBuffer));

    const result = await downloadAttachment('https://example.com/file', 'my file (1).png');

    expect(result).toMatch(/my_file__1_\.png$/);
    expect(result).not.toContain(' ');
    expect(result).not.toContain('(');
    expect(result).not.toContain(')');
  });
});

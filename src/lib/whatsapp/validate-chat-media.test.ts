import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { validateChatMedia } from './validate-chat-media';

const ACCOUNT_ID = '11111111-2222-3333-4444-555555555555';
const PROJECT_URL = 'https://project.supabase.co';

function mediaDb(result: {
  data: { contentType: string; size: number } | null;
  error: { status?: number; statusCode?: string; message: string } | null;
}) {
  const info = vi.fn(async () => result);
  return {
    db: {
      storage: { from: vi.fn(() => ({ info })) },
    } as unknown as SupabaseClient,
    info,
  };
}

function publicUrl(path = `account-${ACCOUNT_ID}/1770000000000-clip.mp4`) {
  return `${PROJECT_URL}/storage/v1/object/public/chat-media/${path}`;
}

describe('validateChatMedia', () => {
  it('accepts supported video metadata for an account-owned URL', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', PROJECT_URL);
    const { db, info } = mediaDb({
      data: { contentType: 'video/mp4', size: 1024 },
      error: null,
    });

    await expect(
      validateChatMedia(db, ACCOUNT_ID, 'video', publicUrl())
    ).resolves.toBeUndefined();
    expect(info).toHaveBeenCalledWith(
      `account-${ACCOUNT_ID}/1770000000000-clip.mp4`
    );
  });

  it('accepts supported document metadata', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', PROJECT_URL);
    const { db } = mediaDb({
      data: { contentType: 'application/pdf', size: 1024 },
      error: null,
    });

    await expect(
      validateChatMedia(
        db,
        ACCOUNT_ID,
        'document',
        publicUrl(`account-${ACCOUNT_ID}/invoice.pdf`)
      )
    ).resolves.toBeUndefined();
  });

  it.each([
    [
      'foreign host',
      'https://evil.example/storage/v1/object/public/chat-media/account-x/file.mp4',
    ],
    ['foreign account', publicUrl('account-other/file.mp4')],
    ['query string', `${publicUrl()}?download=1`],
    ['non-HTTPS URL', publicUrl().replace('https:', 'http:')],
  ])('rejects a media URL with %s', async (_label, url) => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', PROJECT_URL);
    const { db, info } = mediaDb({
      data: { contentType: 'video/mp4', size: 1024 },
      error: null,
    });

    await expect(
      validateChatMedia(db, ACCOUNT_ID, 'video', url)
    ).rejects.toThrow(/media_url/);
    expect(info).not.toHaveBeenCalled();
  });

  it('rejects unsupported MIME types and over-limit files', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', PROJECT_URL);
    const unsupported = mediaDb({
      data: { contentType: 'video/webm', size: 1024 },
      error: null,
    });
    await expect(
      validateChatMedia(unsupported.db, ACCOUNT_ID, 'video', publicUrl())
    ).rejects.toThrow(/Unsupported video MIME type/);

    const tooLarge = mediaDb({
      data: { contentType: 'application/pdf', size: 16 * 1024 * 1024 + 1 },
      error: null,
    });
    await expect(
      validateChatMedia(
        tooLarge.db,
        ACCOUNT_ID,
        'document',
        publicUrl(`account-${ACCOUNT_ID}/invoice.pdf`)
      )
    ).rejects.toThrow(/between 1 byte/);

    const tooLargeVideo = mediaDb({
      data: { contentType: 'video/mp4', size: 16 * 1024 * 1024 + 1 },
      error: null,
    });
    await expect(
      validateChatMedia(tooLargeVideo.db, ACCOUNT_ID, 'video', publicUrl())
    ).rejects.toThrow(/between 1 byte/);
  });

  it('accepts files exactly at the 16 MiB upload cap', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', PROJECT_URL);
    const video = mediaDb({
      data: { contentType: 'video/mp4', size: 16 * 1024 * 1024 },
      error: null,
    });
    const document = mediaDb({
      data: { contentType: 'application/pdf', size: 16 * 1024 * 1024 },
      error: null,
    });

    await expect(
      validateChatMedia(video.db, ACCOUNT_ID, 'video', publicUrl())
    ).resolves.toBeUndefined();
    await expect(
      validateChatMedia(
        document.db,
        ACCOUNT_ID,
        'document',
        publicUrl(`account-${ACCOUNT_ID}/invoice.pdf`)
      )
    ).resolves.toBeUndefined();
  });

  it('rejects missing Storage objects', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', PROJECT_URL);
    const { db } = mediaDb({
      data: null,
      error: { status: 404, statusCode: '404', message: 'Not found' },
    });

    await expect(
      validateChatMedia(db, ACCOUNT_ID, 'video', publicUrl())
    ).rejects.toThrow(/accessible chat-media upload/);
  });
});

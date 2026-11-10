import type { SupabaseClient } from '@supabase/supabase-js';
import { MEDIA_MAX_BYTES_BY_KIND } from '@/lib/storage/upload-media';
import { MEDIA_HEADER_SPECS, type MediaHeaderKind } from './media-header-types';

export class ChatMediaValidationError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'ChatMediaValidationError';
  }
}

/**
 * Validate that a video/document URL points to an uploaded object in this
 * account's public chat-media bucket, then validate its stored MIME type
 * and byte size. The metadata lookup runs through the caller's RLS-scoped
 * client, so an account-prefixed URL alone never grants access.
 */
export async function validateChatMedia(
  supabase: SupabaseClient,
  accountId: string,
  kind: Extract<MediaHeaderKind, 'video' | 'document'>,
  value: unknown
): Promise<void> {
  if (typeof value !== 'string') {
    throw new ChatMediaValidationError('media_url is required');
  }

  let url: URL;
  let projectUrl: URL;
  try {
    url = new URL(value);
    projectUrl = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!);
  } catch {
    throw new ChatMediaValidationError('media_url must be a valid Storage URL');
  }

  const expectedPrefix = `/storage/v1/object/public/chat-media/account-${accountId}/`;
  if (
    url.protocol !== 'https:' ||
    url.origin !== projectUrl.origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith(expectedPrefix)
  ) {
    throw new ChatMediaValidationError(
      "media_url must reference this account's chat-media upload"
    );
  }

  const encodedObjectPath = url.pathname.slice(
    '/storage/v1/object/public/chat-media/'.length
  );
  let objectPath: string;
  try {
    const segments = encodedObjectPath.split('/').map(decodeURIComponent);
    if (
      segments.some(
        (segment) =>
          !segment ||
          segment === '.' ||
          segment === '..' ||
          segment.includes('/') ||
          segment.includes('\\') ||
          /[\u0000-\u001f\u007f]/.test(segment)
      )
    ) {
      throw new Error('Invalid object path');
    }
    objectPath = segments.join('/');
  } catch {
    throw new ChatMediaValidationError(
      'media_url contains an invalid object path'
    );
  }

  const { data, error } = await supabase.storage
    .from('chat-media')
    .info(objectPath);

  if (error) {
    if (error.statusCode === '404' || error.status === 404) {
      throw new ChatMediaValidationError(
        'media_url does not reference an accessible chat-media upload'
      );
    }
    throw new Error(`Unable to inspect uploaded chat media: ${error.message}`);
  }

  const mimeType = data.contentType?.split(';', 1)[0].trim().toLowerCase();
  if (!mimeType || !MEDIA_HEADER_SPECS[kind].mimeTypes.includes(mimeType)) {
    throw new ChatMediaValidationError(
      `Unsupported ${kind} MIME type${mimeType ? `: ${mimeType}` : ''}`
    );
  }

  const maxBytes = MEDIA_MAX_BYTES_BY_KIND[kind];
  if (
    typeof data.size !== 'number' ||
    !Number.isFinite(data.size) ||
    data.size <= 0 ||
    data.size > maxBytes
  ) {
    throw new ChatMediaValidationError(
      `${kind} file must be between 1 byte and ${maxBytes} bytes`
    );
  }
}

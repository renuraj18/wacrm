/** Columns, in the order they appear in the exported file. */
export const CONTACT_EXPORT_HEADERS = [
  'Name',
  'Phone',
  'Email',
  'Company',
  'WhatsApp username',
  'Tags',
  'Created',
] as const;

export interface ContactExportRow {
  contact: {
    name?: string | null;
    phone: string;
    email?: string | null;
    company?: string | null;
    wa_username?: string | null;
    created_at: string;
  };
  tags: string[];
}

/**
 * Quote a CSV cell. Cells starting with = + - @ (or a tab / CR) are
 * prefixed with an apostrophe so a spreadsheet opens them as text rather
 * than running them as formulas (CSV injection).
 */
export function csvCell(value: string | null | undefined): string {
  let v = value ?? '';
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Full CSV document (UTF-8 BOM so Excel reads Tamil/Hindi names correctly). */
export function buildContactsCsv(rows: ContactExportRow[]): string {
  const lines = [CONTACT_EXPORT_HEADERS.map(csvCell).join(',')];
  for (const { contact: c, tags } of rows) {
    lines.push(
      [
        c.name,
        c.phone,
        c.email,
        c.company,
        c.wa_username ?? '',
        tags.join('; '),
        c.created_at ? c.created_at.slice(0, 10) : '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

export function contactsExportFilename(now: Date = new Date()): string {
  return `contacts-${now.toISOString().slice(0, 10)}.csv`;
}

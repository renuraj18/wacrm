import { describe, expect, it } from "vitest";
import { buildContactsCsv, contactsExportFilename, csvCell } from './export-csv';

describe('csvCell', () => {
  it('leaves plain values alone and quotes ones with commas, quotes or newlines', () => {
    expect(csvCell('Priya')).toBe('Priya');
    expect(csvCell('Shanthi, Salem')).toBe('"Shanthi, Salem"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });
  it('treats null and undefined as empty', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });
  it('neutralises spreadsheet formulas', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('+91 9632982245')).toBe(`'+91 9632982245`);
    expect(csvCell('-5')).toBe(`'-5`);
    expect(csvCell('@admin')).toBe(`'@admin`);
  });
});

describe('buildContactsCsv', () => {
  it('writes a BOM, a header row and one line per contact with tags joined', () => {
    const csv = buildContactsCsv([
      {
        contact: {
          name: 'Priya',
          phone: '919632982245',
          email: 'priya@example.com',
          company: 'Shanthi Boutique',
          wa_username: 'priya.s',
          created_at: '2026-11-03T10:00:00.000Z',
        },
        tags: ['VIP', 'Wedding'],
      },
      {
        contact: { name: null, phone: '', email: null, company: null, wa_username: null, created_at: '' },
        tags: [],
      },
    ]);
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.slice(1).trimEnd().split('\r\n');
    expect(lines[0]).toBe('Name,Phone,Email,Company,WhatsApp username,Tags,Created');
    expect(lines[1]).toBe('Priya,919632982245,priya@example.com,Shanthi Boutique,priya.s,VIP; Wedding,2026-11-03');
    expect(lines[2]).toBe(',,,,,,');
  });
  it('quotes a company with a comma so the columns stay aligned', () => {
    const csv = buildContactsCsv([
      { contact: { name: 'A', phone: '1', email: null, company: 'Silk, Cotton', wa_username: null, created_at: '' }, tags: [] },
    ]);
    expect(csv.split('\r\n')[1]).toBe('A,1,,"Silk, Cotton",,,');
  });
});

describe('contactsExportFilename', () => {
  it('uses the date', () => {
    expect(contactsExportFilename(new Date('2026-11-10T08:00:00Z'))).toBe('contacts-2026-11-10.csv');
  });
});

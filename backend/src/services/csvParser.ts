import { parse } from 'csv-parse/sync';
import * as XLSX from 'xlsx';

export interface ParsedCandidateRow {
  fullName: string;
  phone: string;
  email: string | null;
  nationalIdLast4: string;
  score: number;
  passed: boolean;
}

export interface RowValidationError {
  row: number;
  field: string;
  message: string;
}

function normalizePhone(raw: string): string | null {
  const cleaned = raw.replace(/[\s\-()]/g, '');
  if (/^\+91\d{10}$/.test(cleaned)) return cleaned;
  if (/^91\d{10}$/.test(cleaned)) return `+${cleaned}`;
  if (/^[6-9]\d{9}$/.test(cleaned)) return `+91${cleaned}`;
  return null;
}

function parseBooleanPass(val: unknown): boolean | null {
  if (typeof val === 'boolean') return val;
  const s = String(val ?? '').trim().toLowerCase();
  if (['true', 'yes', 'pass', 'passed', '1'].includes(s)) return true;
  if (['false', 'no', 'fail', 'failed', '0'].includes(s)) return false;
  return null;
}

export function parseAndValidateSpreadsheet(
  buffer: Buffer,
  filename: string
): { valid: true; rows: ParsedCandidateRow[] } | { valid: false; errors: RowValidationError[] } {
  let rawRecords: Record<string, unknown>[] = [];

  try {
    const ext = filename.toLowerCase();
    if (ext.endsWith('.xlsx') || ext.endsWith('.xls')) {
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      const firstSheet = workbook.SheetNames[0];
      if (!firstSheet) {
        return { valid: false, errors: [{ row: 0, field: 'file', message: 'Workbook has no sheets' }] };
      }
      rawRecords = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[firstSheet], {
        defval: '',
      });
    } else {
      rawRecords = parse(buffer.toString('utf-8'), {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      });
    }
  } catch (err) {
    return {
      valid: false,
      errors: [{ row: 0, field: 'file', message: `Could not parse spreadsheet: ${(err as Error).message}` }],
    };
  }

  if (rawRecords.length === 0) {
    return {
      valid: false,
      errors: [{ row: 0, field: 'file', message: 'Spreadsheet contains no candidate rows' }],
    };
  }

  const errors: RowValidationError[] = [];
  const validRows: ParsedCandidateRow[] = [];
  const seenPhones = new Set<string>();

  rawRecords.forEach((record, idx) => {
    const rowNum = idx + 2; // 1-indexed + header row

    // Support flexible header aliases
    const rawName = String(
      record.fullName ?? record.full_name ?? record.name ?? record.Name ?? ''
    ).trim();
    const rawPhone = String(
      record.phone ?? record.mobile ?? record.Phone ?? record.Mobile ?? ''
    ).trim();
    const rawEmail = String(record.email ?? record.Email ?? '').trim();
    const rawIdLast4 = String(
      record.nationalIdLast4 ??
        record.national_id_last4 ??
        record.idLast4 ??
        record.aadhaarLast4 ??
        record.aadhaar_last4 ??
        ''
    ).trim();
    const rawScore = record.score ?? record.Score ?? record.marks ?? record.Marks;
    const rawPassed = record.passed ?? record.Passed ?? record.result ?? record.Result ?? 'PASS';

    if (rawName.length < 2) {
      errors.push({ row: rowNum, field: 'fullName', message: 'Full name must be at least 2 characters' });
    }

    const normalizedPhone = normalizePhone(rawPhone);
    if (!normalizedPhone) {
      errors.push({
        row: rowNum,
        field: 'phone',
        message: `Invalid phone "${rawPhone}". Expected 10-digit Indian mobile or +91XXXXXXXXXX`,
      });
    } else if (seenPhones.has(normalizedPhone)) {
      errors.push({
        row: rowNum,
        field: 'phone',
        message: `Duplicate phone number "${normalizedPhone}" within batch`,
      });
    } else {
      seenPhones.add(normalizedPhone);
    }

    if (rawEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
      errors.push({ row: rowNum, field: 'email', message: `Invalid email "${rawEmail}"` });
    }

    // NOTE: the last 4 digits of an ID are not unique per person (collisions are common in a
    // batch of 60+), so only the *format* is validated. Identity within a batch is the phone.
    if (!/^\d{4}$/.test(rawIdLast4)) {
      errors.push({
        row: rowNum,
        field: 'nationalIdLast4',
        message: `Invalid ID last 4 digits "${rawIdLast4}". Must be exactly 4 digits`,
      });
    }

    const scoreNum = Number(rawScore);
    if (rawScore === '' || rawScore === undefined || Number.isNaN(scoreNum) || scoreNum < 0 || scoreNum > 100) {
      errors.push({
        row: rowNum,
        field: 'score',
        message: `Invalid score "${rawScore}". Must be a number between 0 and 100`,
      });
    }

    const passedBool = parseBooleanPass(rawPassed);
    if (passedBool === null) {
      errors.push({
        row: rowNum,
        field: 'passed',
        message: `Invalid passed value "${rawPassed}". Expected PASS/FAIL or true/false`,
      });
    } else if (!passedBool) {
      errors.push({
        row: rowNum,
        field: 'passed',
        message: 'Only passed candidates can be uploaded for certification',
      });
    }

    if (errors.length === 0 && normalizedPhone && passedBool !== null) {
      validRows.push({
        fullName: rawName,
        phone: normalizedPhone,
        email: rawEmail || null,
        nationalIdLast4: rawIdLast4,
        score: Math.round(scoreNum),
        passed: passedBool,
      });
    }
  });

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, rows: validRows };
}

// Cloudflare Pages Function: GET & POST /api/student-words (rev 2026-10-28)
// Cloud-syncs each student's personal vocabulary collection for the 10-Day White Hmong Language Course.
const BASE_ID_DEFAULT = 'app3EYXcC98lSdj46'; // Hmong Language Course
const TABLE_ID_DEFAULT = 'tbl1BVwFM2yXr4xAk'; // Student Words
const MAX_BODY = 100000;
const MAX_WORDS = 300;

const ROSTER = {
  'HMOOB-01': 'Stephen Trumble (Bền)',
  'HMOOB-02': 'Quỳnh Trumble',
  'HMOOB-03': 'Quân Nguyễn (Nguyễn Bá Anh Quân)',
  'HMOOB-04': 'Jade Trần (Trần Hoàng Kim Jade)',
  'HMOOB-05': 'Thái Lý (Lý Vĩnh Thái)',
  'HMOOB-06': 'Sa-ra Nguyễn (Nguyễn Mỹ Sa-ra)',
  'HMOOB-07': 'Minh Lê (Lê Thị Minh)',
  'HMOOB-08': 'Phương Nguyễn (Nguyễn Minh Phương)',
  'HMOOB-09': 'Hùng Nguyễn (Nguyễn Lý Hùng)',
  'HMOOB-10': 'Tuyết Nguyễn (Nguyễn Thị Ánh Tuyết)',
  'HMOOB-11': 'David Rorke',
  'HMOOB-12': 'Hoa Phạm (Phạm Thị Hoa)',
  'HMOOB-13': 'Student 13',
  'HMOOB-14': 'Student 14',
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });

const clean = (v, max) =>
  typeof v === 'string' ? v.replace(/\u0000/g, '').trim().slice(0, max) : '';

function normalizeCode(rawCode) {
  if (typeof rawCode !== 'string') return '';
  let code = rawCode.trim().toUpperCase();
  if (!/^[A-Z0-9-]{3,24}$/.test(code)) return '';
  code = code.replace(/^HMONG-/, 'HMOOB-');
  return code;
}

function sanitizeWords(rawWords) {
  if (!Array.isArray(rawWords)) return [];
  const out = [];
  const seen = new Set();
  for (const item of rawWords) {
    if (!item || typeof item !== 'object') continue;
    const hmong = clean(item.hmong || item.w || '', 80);
    const en = clean(item.en || '', 120);
    const vi = clean(item.vi || '', 120);
    const ko = clean(item.ko || '', 120);
    const ja = clean(item.ja || '', 120);
    const pos = clean(item.pos || item.role || 'obj', 32) || 'obj';
    const img = clean(item.img || '', 400);
    const emoji = clean(item.emoji || '', 24);
    const fallback = en || vi || ko || ja;
    if (!hmong || !fallback) continue;
    const key = hmong.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const wordObj = {
      hmong,
      en: en || fallback,
      vi: vi || fallback,
      ko: ko || fallback,
      ja: ja || fallback,
      pos,
    };
    if (img) wordObj.img = img;
    if (emoji) wordObj.emoji = emoji;
    out.push(wordObj);
    if (out.length >= MAX_WORDS) break;
  }
  return out;
}

function getConfig(env) {
  return {
    token: env.HMONG_AIRTABLE_TOKEN || env.AIRTABLE_TOKEN || '',
    base: env.HMONG_AIRTABLE_BASE_ID || BASE_ID_DEFAULT,
    table: env.HMONG_AIRTABLE_TABLE_ID || TABLE_ID_DEFAULT,
  };
}

async function findRecordByCode(cfg, code) {
  const formula = `UPPER({Student Code})='${code}'`;
  const url = `https://api.airtable.com/v0/${cfg.base}/${encodeURIComponent(cfg.table)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;
  const r = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
  if (!r.ok) {
    const errText = (await r.text()).slice(0, 300);
    console.error('Airtable GET error', r.status, errText);
    return { error: 'upstream', status: r.status };
  }
  const data = await r.json();
  const rec = Array.isArray(data.records) && data.records.length > 0 ? data.records[0] : null;
  return { record: rec };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const code = normalizeCode(url.searchParams.get('code') || '');
  if (!code) return json({ ok: false, error: 'invalid_code' }, 400);

  const cfg = getConfig(env);
  if (!cfg.token) {
    if (ROSTER[code]) {
      return json({
        ok: true,
        code,
        studentName: ROSTER[code],
        words: [],
        updatedAt: '',
        mode: 'roster_fallback',
      });
    }
    return json({ ok: false, error: 'not_configured' }, 503);
  }

  try {
    const lookup = await findRecordByCode(cfg, code);
    if (lookup.error) {
      if (ROSTER[code]) {
        return json({
          ok: true,
          code,
          studentName: ROSTER[code],
          words: [],
          updatedAt: '',
          mode: 'roster_fallback',
        });
      }
      return json({ ok: false, error: lookup.error }, 502);
    }

    if (!lookup.record) {
      if (ROSTER[code]) {
        return json({
          ok: true,
          code,
          studentName: ROSTER[code],
          words: [],
          updatedAt: '',
          mode: 'roster_fallback',
        });
      }
      return json({ ok: false, error: 'not_found' }, 404);
    }

    const fields = lookup.record.fields || {};
    let words = [];
    try {
      const parsed = JSON.parse(fields['Custom Words JSON'] || '[]');
      words = sanitizeWords(parsed);
    } catch {
      words = [];
    }

    return json({
      ok: true,
      code,
      studentName: fields['Student Name'] || ROSTER[code] || '',
      words,
      updatedAt: fields['Updated At'] || '',
    });
  } catch (e) {
    console.error('student-words GET failed', String(e));
    return json({ ok: false, error: 'upstream' }, 502);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) return json({ ok: false, error: 'too_large' }, 413);

  let raw;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) return json({ ok: false, error: 'too_large' }, 413);
    raw = JSON.parse(text);
  } catch {
    return json({ ok: false, error: 'bad_request' }, 400);
  }
  if (!raw || typeof raw !== 'object') return json({ ok: false, error: 'bad_request' }, 400);

  // Optional seed action to initialize all 14 student rows if missing
  if (raw.action === 'seed_roster') {
    const cfg = getConfig(env);
    if (!cfg.token) return json({ ok: false, error: 'not_configured' }, 503);
    try {
      const listUrl = `https://api.airtable.com/v0/${cfg.base}/${encodeURIComponent(cfg.table)}?pageSize=100`;
      const listRes = await fetch(listUrl, { headers: { Authorization: `Bearer ${cfg.token}` } });
      if (!listRes.ok) return json({ ok: false, error: 'upstream', status: listRes.status }, 502);
      const listData = await listRes.json();
      const existingCodes = new Set(
        (listData.records || [])
          .map((r) => normalizeCode((r.fields && r.fields['Student Code']) || ''))
          .filter(Boolean)
      );
      const toCreate = [];
      for (const [c, name] of Object.entries(ROSTER)) {
        if (!existingCodes.has(c)) {
          toCreate.push({
            fields: {
              'Student Code': c,
              'Student Name': name,
              'Custom Words JSON': '[]',
              'Updated At': '2026-10-27',
            },
          });
        }
      }
      for (let i = 0; i < toCreate.length; i += 10) {
        const batch = toCreate.slice(i, i + 10);
        const cr = await fetch(`https://api.airtable.com/v0/${cfg.base}/${encodeURIComponent(cfg.table)}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ records: batch, typecast: false }),
        });
        if (!cr.ok) return json({ ok: false, error: 'upstream', status: cr.status }, 502);
      }
      return json({ ok: true, created: toCreate.length, existing: existingCodes.size });
    } catch (e) {
      console.error('seed_roster error', String(e));
      return json({ ok: false, error: 'upstream' }, 502);
    }
  }

  const code = normalizeCode(raw.code || '');
  if (!code) return json({ ok: false, error: 'invalid_code' }, 400);

  const cleanWords = sanitizeWords(raw.words);
  const updatedAt = new Date().toISOString();
  const cfg = getConfig(env);

  if (!cfg.token) {
    return json({ ok: false, error: 'not_configured', code, studentName: ROSTER[code] || '' }, 503);
  }

  try {
    const lookup = await findRecordByCode(cfg, code);
    if (lookup.error) {
      return json({ ok: false, error: lookup.error, code, studentName: ROSTER[code] || '' }, 502);
    }

    if (lookup.record) {
      const recordId = lookup.record.id;
      const existingFields = lookup.record.fields || {};
      const studentName = existingFields['Student Name'] || ROSTER[code] || clean(raw.studentName || '', 120);
      const patchFields = {
        'Custom Words JSON': JSON.stringify(cleanWords),
        'Updated At': updatedAt,
      };
      if (studentName && !existingFields['Student Name']) {
        patchFields['Student Name'] = studentName;
      }
      const pr = await fetch(`https://api.airtable.com/v0/${cfg.base}/${encodeURIComponent(cfg.table)}/${recordId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: patchFields, typecast: false }),
      });
      if (!pr.ok) {
        console.error('Airtable PATCH error', pr.status, (await pr.text()).slice(0, 300));
        return json({ ok: false, error: 'upstream' }, 502);
      }
      return json({
        ok: true,
        code,
        studentName,
        count: cleanWords.length,
        updatedAt,
      });
    } else {
      const studentName = ROSTER[code] || clean(raw.studentName || '', 120);
      const createFields = {
        'Student Code': code,
        'Custom Words JSON': JSON.stringify(cleanWords),
        'Updated At': updatedAt,
      };
      if (studentName) createFields['Student Name'] = studentName;

      const cr = await fetch(`https://api.airtable.com/v0/${cfg.base}/${encodeURIComponent(cfg.table)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: [{ fields: createFields }], typecast: false }),
      });
      if (!cr.ok) {
        console.error('Airtable POST error', cr.status, (await cr.text()).slice(0, 300));
        return json({ ok: false, error: 'upstream' }, 502);
      }
      return json({
        ok: true,
        code,
        studentName,
        count: cleanWords.length,
        updatedAt,
      });
    }
  } catch (e) {
    console.error('student-words POST failed', String(e));
    return json({ ok: false, error: 'upstream' }, 502);
  }
}

export function onRequest() {
  return json({ ok: false, error: 'method_not_allowed' }, 405);
}

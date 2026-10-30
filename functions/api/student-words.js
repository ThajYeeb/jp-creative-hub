// Cloudflare Pages Function: GET & POST /api/student-words (rev 2026-10-28)
// Cloud-syncs each student's personal vocabulary collection for the 10-Day White Hmong Language Course.
const BASE_ID_DEFAULT = 'app3EYXcC98lSdj46'; // Hmong Language Course
const TABLE_ID_DEFAULT = 'tbl1BVwFM2yXr4xAk'; // Student Words
const MAX_BODY = 100000;
const MAX_WORDS = 300;
const MAX_UPLOAD_BODY = 300000; // base64 of a <=200KB photo + JSON wrapper
const MAX_PHOTO_BYTES = 200 * 1024;
const MAX_PHOTOS = 50;
const PHOTO_FIELD = 'Photo';

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
  'HMOOB-13': 'Kim Kwang Tae',
  'HMOOB-14': 'Lee Jong Hee',
  'HMOOB-15': 'Tsim Meej',
  'HMOOB-16': 'Paj Nyiag',
  'HMOOB-17': 'Txawj Thaiv',
  'HMOOB-18': 'Nkauj Huab',
  'HMOOB-19': 'Kim Kim',
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

function photoProxyUrl(code, attId) {
  return `/api/student-words?code=${encodeURIComponent(code)}&photo=${encodeURIComponent(attId)}`;
}

async function getOrCreateRecord(cfg, code, studentName) {
  const lookup = await findRecordByCode(cfg, code);
  if (lookup.error) return lookup;
  if (lookup.record) return lookup;
  const fields = { 'Student Code': code, 'Custom Words JSON': '[]', 'Updated At': new Date().toISOString() };
  const name = ROSTER[code] || studentName;
  if (name) fields['Student Name'] = name;
  const cr = await fetch(`https://api.airtable.com/v0/${cfg.base}/${encodeURIComponent(cfg.table)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ records: [{ fields }], typecast: false }),
  });
  if (!cr.ok) return { error: 'upstream', status: cr.status };
  const d = await cr.json();
  return { record: d.records && d.records[0] };
}

async function handleUploadPhoto(cfg, raw, code) {
  let b64 = typeof raw.data === 'string' ? raw.data.trim() : '';
  const m = /^data:image\/jpeg;base64,/i.exec(b64);
  if (m) b64 = b64.slice(m[0].length);
  if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) return json({ ok: false, error: 'bad_image' }, 400);
  const bytes = Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
  if (bytes > MAX_PHOTO_BYTES) return json({ ok: false, error: 'photo_too_large', maxBytes: MAX_PHOTO_BYTES }, 413);
  if (!b64.startsWith('/9j/')) return json({ ok: false, error: 'bad_image' }, 400); // JPEG magic FF D8 FF
  const lookup = await getOrCreateRecord(cfg, code, clean(raw.studentName || '', 120));
  if (lookup.error || !lookup.record) return json({ ok: false, error: 'upstream' }, 502);
  const rec = lookup.record;
  const existing = Array.isArray(rec.fields && rec.fields[PHOTO_FIELD]) ? rec.fields[PHOTO_FIELD] : [];
  if (existing.length >= MAX_PHOTOS) {
    return json({ ok: false, error: 'photo_limit', max: MAX_PHOTOS, count: existing.length }, 409);
  }
  const slug = clean(raw.hmong || 'word', 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'word';
  const filename = `${code}-${slug}-${Date.now()}.jpg`;
  const up = await fetch(`https://content.airtable.com/v0/${cfg.base}/${rec.id}/${encodeURIComponent(PHOTO_FIELD)}/uploadAttachment`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentType: 'image/jpeg', file: b64, filename }),
  });
  if (!up.ok) {
    console.error('Airtable uploadAttachment error', up.status, (await up.text()).slice(0, 300));
    return json({ ok: false, error: 'upstream' }, 502);
  }
  const d = await up.json();
  const oldIds = new Set(existing.map((a) => a.id));
  const fieldVals = Object.values(d.fields || {}).find((v) => Array.isArray(v)) || [];
  const att = fieldVals.find((a) => a && a.filename === filename) || fieldVals.find((a) => a && !oldIds.has(a.id));
  if (!att) return json({ ok: false, error: 'upstream' }, 502);
  return json({ ok: true, code, id: att.id, url: photoProxyUrl(code, att.id), count: existing.length + 1, max: MAX_PHOTOS });
}

async function handleDeletePhoto(cfg, raw, code) {
  const id = clean(raw.id || '', 40);
  if (!/^att[A-Za-z0-9]+$/.test(id)) return json({ ok: false, error: 'bad_request' }, 400);
  const lookup = await findRecordByCode(cfg, code);
  if (lookup.error || !lookup.record) return json({ ok: false, error: lookup.error || 'not_found' }, 404);
  const existing = Array.isArray(lookup.record.fields[PHOTO_FIELD]) ? lookup.record.fields[PHOTO_FIELD] : [];
  const keep = existing.filter((a) => a.id !== id).map((a) => ({ id: a.id }));
  if (keep.length === existing.length) return json({ ok: true, code, deleted: 0, count: keep.length });
  const pr = await fetch(`https://api.airtable.com/v0/${cfg.base}/${encodeURIComponent(cfg.table)}/${lookup.record.id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { [PHOTO_FIELD]: keep } }),
  });
  if (!pr.ok) return json({ ok: false, error: 'upstream' }, 502);
  return json({ ok: true, code, deleted: 1, count: keep.length });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const code = normalizeCode(url.searchParams.get('code') || '');
  if (!code) return json({ ok: false, error: 'invalid_code' }, 400);

  const cfg = getConfig(env);

  // Photo proxy: Airtable attachment URLs expire, so cards store this stable URL instead.
  const photoId = url.searchParams.get('photo');
  if (photoId !== null) {
    if (!/^att[A-Za-z0-9]+$/.test(photoId) || !cfg.token) return json({ ok: false, error: 'not_found' }, 404);
    try {
      const lookup = await findRecordByCode(cfg, code);
      const list = lookup.record && Array.isArray(lookup.record.fields[PHOTO_FIELD]) ? lookup.record.fields[PHOTO_FIELD] : [];
      const att = list.find((a) => a.id === photoId);
      if (!att) return json({ ok: false, error: 'not_found' }, 404);
      const thumb = att.thumbnails && att.thumbnails.large && att.thumbnails.large.url;
      return new Response(null, { status: 302, headers: { Location: att.url || thumb, 'Cache-Control': 'private, max-age=600' } });
    } catch (e) {
      return json({ ok: false, error: 'upstream' }, 502);
    }
  }
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
  if (len > MAX_UPLOAD_BODY) return json({ ok: false, error: 'too_large' }, 413);

  let raw;
  try {
    const text = await request.text();
    if (text.length > MAX_UPLOAD_BODY) return json({ ok: false, error: 'too_large' }, 413);
    raw = JSON.parse(text);
    if (raw && raw.action !== 'upload_photo' && text.length > MAX_BODY) return json({ ok: false, error: 'too_large' }, 413);
  } catch {
    return json({ ok: false, error: 'bad_request' }, 400);
  }
  if (!raw || typeof raw !== 'object') return json({ ok: false, error: 'bad_request' }, 400);

  if (raw.action === 'upload_photo' || raw.action === 'delete_photo') {
    const pcode = normalizeCode(raw.code || '');
    if (!pcode) return json({ ok: false, error: 'invalid_code' }, 400);
    const pcfg = getConfig(env);
    if (!pcfg.token) return json({ ok: false, error: 'not_configured' }, 503);
    try {
      return raw.action === 'upload_photo' ? await handleUploadPhoto(pcfg, raw, pcode) : await handleDeletePhoto(pcfg, raw, pcode);
    } catch (e) {
      console.error('photo action failed', String(e));
      return json({ ok: false, error: 'upstream' }, 502);
    }
  }

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

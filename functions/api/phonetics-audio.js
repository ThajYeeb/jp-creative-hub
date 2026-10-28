// Cloudflare Pages Function: GET & POST /api/phonetics-audio (rev 2026-10-28)
// Cloud-syncs Male (JC) and Female (Pang) instructor audio clips for the 71 White Hmong (RPA) phonetics items.
// Uses Airtable table tbl1BVwFM2yXr4xAk (Student Words) in base app3EYXcC98lSdj46 (Hmong Language Course)
// with Student Code = "PHON-<ID>" so each phonetic item stays well under Airtable's 100KB cell limit:
//   - Custom Words JSON -> Male voice audio Data URL (up to 95,000 chars)
//   - Progress JSON     -> Female voice audio Data URL (up to 95,000 chars)

const BASE_ID_DEFAULT = 'app3EYXcC98lSdj46'; // Hmong Language Course
const TABLE_ID_DEFAULT = 'tbl1BVwFM2yXr4xAk'; // Student Words
const MAX_BODY = 110000;
const MAX_CLIP_CHARS = 95000;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });

function getConfig(env) {
  return {
    token: env.HMONG_AIRTABLE_TOKEN || env.AIRTABLE_TOKEN || '',
    base: env.HMONG_AIRTABLE_BASE_ID || BASE_ID_DEFAULT,
    table: env.HMONG_AIRTABLE_TABLE_ID || TABLE_ID_DEFAULT,
  };
}

function normalizeId(rawId) {
  if (typeof rawId !== 'string') return '';
  const id = rawId.trim().toLowerCase().replace(/^phon-/, '');
  if (!/^[a-z0-9_]{2,24}$/.test(id)) return '';
  return id;
}

function toStudentCode(id) {
  return 'PHON-' + id.toUpperCase();
}

function parseVoicePayload(customVal, progressVal) {
  let male = '';
  let female = '';
  if (typeof customVal === 'string' && customVal.trim()) {
    const trimmed = customVal.trim();
    if (trimmed.startsWith('data:audio/') || trimmed.startsWith('data:video/') || trimmed.startsWith('data:application/octet-stream')) {
      male = trimmed;
    } else if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed.male === 'string') male = parsed.male;
        if (parsed && typeof parsed.female === 'string') female = parsed.female;
      } catch {
        // ignore invalid json
      }
    }
  }
  if (typeof progressVal === 'string' && progressVal.trim()) {
    const trimmed = progressVal.trim();
    if (trimmed.startsWith('data:audio/') || trimmed.startsWith('data:video/') || trimmed.startsWith('data:application/octet-stream')) {
      female = trimmed;
    }
  }
  return { male, female };
}

async function findRecordByStudentCode(cfg, studentCode) {
  const formula = `UPPER({Student Code})='${studentCode}'`;
  const url = `https://api.airtable.com/v0/${cfg.base}/${encodeURIComponent(cfg.table)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;
  const r = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
  if (!r.ok) {
    const errText = (await r.text()).slice(0, 300);
    console.error('Airtable GET phonetics-audio error', r.status, errText);
    return { error: 'upstream', status: r.status };
  }
  const data = await r.json();
  const rec = Array.isArray(data.records) && data.records.length > 0 ? data.records[0] : null;
  return { record: rec };
}

export async function onRequestGet(context) {
  const { env } = context;
  const cfg = getConfig(env);
  if (!cfg.token) {
    return json({ ok: true, clips: {}, mode: 'local_only' });
  }

  try {
    const clips = {};
    let offset = '';
    const formula = "FIND('PHON-', {Student Code})=1";

    for (let page = 0; page < 5; page++) {
      let url = `https://api.airtable.com/v0/${cfg.base}/${encodeURIComponent(cfg.table)}?filterByFormula=${encodeURIComponent(formula)}&pageSize=100`;
      if (offset) url += `&offset=${encodeURIComponent(offset)}`;

      const r = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${cfg.token}` },
      });
      if (!r.ok) {
        const errText = (await r.text()).slice(0, 300);
        console.error('phonetics-audio list error', r.status, errText);
        return json({ ok: false, error: 'upstream', clips: {} }, 502);
      }

      const data = await r.json();
      for (const rec of data.records || []) {
        const fields = rec.fields || {};
        const rawCode = String(fields['Student Code'] || '').trim();
        if (!rawCode.toUpperCase().startsWith('PHON-')) continue;
        const id = normalizeId(rawCode.slice(5));
        if (!id) continue;

        const { male, female } = parseVoicePayload(
          fields['Custom Words JSON'],
          fields['Progress JSON']
        );
        if (male || female) {
          clips[id] = {
            male: male || '',
            female: female || '',
            updatedAt: fields['Updated At'] || '',
          };
        }
      }

      if (data.offset) {
        offset = data.offset;
      } else {
        break;
      }
    }

    return json({ ok: true, clips });
  } catch (e) {
    console.error('phonetics-audio GET exception', String(e));
    return json({ ok: false, error: 'upstream', clips: {} }, 502);
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

  const id = normalizeId(raw.id || '');
  if (!id) return json({ ok: false, error: 'invalid_id' }, 400);

  const voice = raw.voice === 'female' ? 'female' : raw.voice === 'male' ? 'male' : '';
  if (!voice) return json({ ok: false, error: 'invalid_voice' }, 400);

  let audioDataUrl = typeof raw.audioDataUrl === 'string' ? raw.audioDataUrl.trim() : '';
  if (audioDataUrl.length > MAX_CLIP_CHARS) {
    return json({ ok: false, error: 'clip_too_large', maxChars: MAX_CLIP_CHARS }, 413);
  }
  if (
    audioDataUrl &&
    !audioDataUrl.startsWith('data:audio/') &&
    !audioDataUrl.startsWith('data:video/') &&
    !audioDataUrl.startsWith('data:application/octet-stream')
  ) {
    return json({ ok: false, error: 'invalid_audio_data_url' }, 400);
  }

  const cfg = getConfig(env);
  if (!cfg.token) {
    return json({ ok: false, error: 'not_configured', id, voice }, 503);
  }

  const studentCode = toStudentCode(id);
  const label = typeof raw.label === 'string' && raw.label.trim()
    ? raw.label.trim().slice(0, 40)
    : id.replace(/^(v_|c[1234]_)/, '');
  const studentName = `Phonetic Audio: ${label}`;
  const updatedAt = new Date().toISOString();
  const targetField = voice === 'male' ? 'Custom Words JSON' : 'Progress JSON';

  try {
    const lookup = await findRecordByStudentCode(cfg, studentCode);
    if (lookup.error) {
      return json({ ok: false, error: lookup.error, id, voice }, 502);
    }

    if (lookup.record) {
      const recordId = lookup.record.id;
      const patchFields = {
        [targetField]: audioDataUrl,
        'Updated At': updatedAt,
      };
      if (!lookup.record.fields || !lookup.record.fields['Student Name']) {
        patchFields['Student Name'] = studentName;
      }

      let pr = await fetch(`https://api.airtable.com/v0/${cfg.base}/${encodeURIComponent(cfg.table)}/${recordId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: patchFields, typecast: false }),
      });

      // Fallback if Progress JSON field doesn't exist on the Airtable table yet: store JSON in Custom Words JSON
      if (!pr.ok && voice === 'female' && pr.status === 422) {
        const existing = parseVoicePayload(
          lookup.record.fields && lookup.record.fields['Custom Words JSON'],
          lookup.record.fields && lookup.record.fields['Progress JSON']
        );
        const combined = JSON.stringify({ male: existing.male || '', female: audioDataUrl });
        if (combined.length <= MAX_CLIP_CHARS) {
          pr = await fetch(`https://api.airtable.com/v0/${cfg.base}/${encodeURIComponent(cfg.table)}/${recordId}`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fields: { 'Custom Words JSON': combined, 'Updated At': updatedAt },
              typecast: false,
            }),
          });
        }
      }

      if (!pr.ok) {
        console.error('Airtable PATCH phonetics-audio error', pr.status, (await pr.text()).slice(0, 300));
        return json({ ok: false, error: 'upstream' }, 502);
      }

      return json({
        ok: true,
        id,
        voice,
        studentCode,
        cleared: !audioDataUrl,
        updatedAt,
      });
    } else {
      const createFields = {
        'Student Code': studentCode,
        'Student Name': studentName,
        [targetField]: audioDataUrl,
        'Updated At': updatedAt,
      };

      let cr = await fetch(`https://api.airtable.com/v0/${cfg.base}/${encodeURIComponent(cfg.table)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: [{ fields: createFields }], typecast: false }),
      });

      if (!cr.ok && voice === 'female' && cr.status === 422) {
        const fallbackFields = {
          'Student Code': studentCode,
          'Student Name': studentName,
          'Custom Words JSON': JSON.stringify({ male: '', female: audioDataUrl }),
          'Updated At': updatedAt,
        };
        cr = await fetch(`https://api.airtable.com/v0/${cfg.base}/${encodeURIComponent(cfg.table)}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ records: [{ fields: fallbackFields }], typecast: false }),
        });
      }

      if (!cr.ok) {
        console.error('Airtable POST phonetics-audio error', cr.status, (await cr.text()).slice(0, 300));
        return json({ ok: false, error: 'upstream' }, 502);
      }

      return json({
        ok: true,
        id,
        voice,
        studentCode,
        cleared: !audioDataUrl,
        updatedAt,
      });
    }
  } catch (e) {
    console.error('phonetics-audio POST exception', String(e));
    return json({ ok: false, error: 'upstream' }, 502);
  }
}

export function onRequest() {
  return json({ ok: false, error: 'method_not_allowed' }, 405);
}

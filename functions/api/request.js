// Cloudflare Pages Function: POST /api/request (rev 2026-10-16)
// Logs website request-form submissions to Airtable (Requests table).
// The Web3Forms email is sent separately from the browser; this never blocks it.
const BASE_ID_DEFAULT = 'app6YIeS789McArMO';
const TABLE_DEFAULT = 'tbl9Cn3jENI92xq6o'; // Requests
const SERVICES = [
  'General question', 'Over-the-phone interpreting (OPI)', 'Video remote interpreting (VRI)',
  'In-person interpreting (Central California only)', 'Translation', 'Proofreading', 'Other',
];
const LIMITS = { name: 120, email: 200, phone: 40, organization: 200, service: 80, dialect: 80, when: 120, setting: 40, details: 5000 };
const MAX_BODY = 20000;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const clean = (v, max) => (typeof v === 'string' ? v.replace(/\u0000/g, '').trim().slice(0, max) : '');

function toDate(s) {
  // Best effort: only set Date Needed if the free-text value parses to a real date.
  if (!s) return null;
  const withYear = /\b\d{4}\b/.test(s) ? s : s + ' ' + new Date().getFullYear();
  const d = new Date(withYear.replace(/\b(PT|PST|PDT)\b/i, '').replace(/,?\s*\d{1,2}(:\d{2})?\s*(am|pm)\b/i, ''));
  if (isNaN(d)) return null;
  return d.toISOString().slice(0, 10);
}

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function sendConfirmation(env, f) {
  // Auto-reply via Resend. Skips quietly if RESEND_API_KEY is not configured.
  if (!env.RESEND_API_KEY) return 'skipped';
  const phrase = f.service ? 'your request for ' + f.service : 'your request';
  const text =
    `Hi ${f.name},\n\n` +
    `Thank you for reaching out to J.P. Creative Hub! We received ${phrase} and will get back to you soon, usually within one business day.\n\n` +
    `If your request is urgent, please call us at (916) 318-5507.\n\n` +
    `Warmly,\nJC and Pang\nJ.P. Creative Hub\ninfo@jpcreativehub.com | jpcreativehub.com\n`;
  const html =
    `<p>Hi ${esc(f.name)},</p>` +
    `<p>Thank you for reaching out to J.P. Creative Hub! We received ${esc(phrase)} and will get back to you soon, usually within one business day.</p>` +
    `<p>If your request is urgent, please call us at <a href="tel:+19163185507">(916) 318-5507</a>.</p>` +
    `<p>Warmly,<br>JC and Pang<br>J.P. Creative Hub<br>` +
    `<a href="mailto:info@jpcreativehub.com">info@jpcreativehub.com</a> | <a href="https://jpcreativehub.com">jpcreativehub.com</a></p>`;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'J.P. Creative Hub <info@jpcreativehub.com>',
        to: [f.email],
        reply_to: 'info@jpcreativehub.com',
        subject: 'We received your request \u2013 J.P. Creative Hub',
        text,
        html,
      }),
    });
    if (!r.ok) { console.error('Resend error', r.status, (await r.text()).slice(0, 300)); return 'failed'; }
    return 'sent';
  } catch (e) {
    console.error('Resend fetch failed', String(e));
    return 'failed';
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
    const ct = request.headers.get('Content-Type') || '';
    raw = ct.includes('application/json') ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text));
  } catch {
    return json({ ok: false, error: 'bad_request' }, 400);
  }
  if (!raw || typeof raw !== 'object') return json({ ok: false, error: 'bad_request' }, 400);

  // Honeypot: bots tick the hidden botcheck box. Pretend success, store nothing.
  if (raw.botcheck) return json({ ok: true });

  const f = {};
  for (const k in LIMITS) f[k] = clean(raw[k], LIMITS[k]);
  if (!f.name || !f.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) return json({ ok: false, error: 'invalid' }, 400);

  // Airtable save and the confirmation email run independently; neither blocks the other.
  const [airtable, email] = await Promise.all([saveToAirtable(env, f), sendConfirmation(env, f)]);
  if (airtable === 'not_configured') return json({ ok: false, error: 'not_configured', email }, 503);
  if (airtable !== 'saved') return json({ ok: false, error: 'upstream', email }, 502);
  return json({ ok: true, email });
}

async function saveToAirtable(env, f) {
  if (!env.AIRTABLE_TOKEN) return 'not_configured';

  const detailParts = [];
  if (f.when) detailParts.push('Date/time needed (as entered): ' + f.when);
  if (f.setting) detailParts.push('Setting: ' + f.setting);
  if (f.details) detailParts.push(f.details);

  const fields = {
    Name: f.name,
    Email: f.email,
    Status: 'New',
    'Submitted At': new Date().toISOString(),
  };
  if (f.phone) fields.Phone = f.phone;
  if (f.organization) fields.Organization = f.organization;
  if (SERVICES.includes(f.service)) fields.Service = f.service;
  else if (f.service) detailParts.unshift('Service (as entered): ' + f.service);
  if (f.dialect) fields['Language/Dialect'] = 'Hmong - ' + f.dialect;
  const d = toDate(f.when);
  if (d) fields['Date Needed'] = d;
  if (detailParts.length) fields.Details = detailParts.join('\n\n');

  const base = env.AIRTABLE_BASE_ID || BASE_ID_DEFAULT;
  const table = env.AIRTABLE_TABLE || TABLE_DEFAULT;
  try {
    const r = await fetch(`https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: [{ fields }], typecast: false }),
    });
    if (!r.ok) {
      console.error('Airtable error', r.status, (await r.text()).slice(0, 500));
      return 'failed';
    }
    return 'saved';
  } catch (e) {
    console.error('Airtable fetch failed', String(e));
    return 'failed';
  }
}

export function onRequest() {
  return json({ ok: false, error: 'method_not_allowed' }, 405);
}

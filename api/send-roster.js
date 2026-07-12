const PdfPrinter = require('pdfmake');

const BUBBLE_BASE = 'https://knightingale.com.au/api/1.1/obj';
const BUBBLE_KEY = process.env.BUBBLE_API_KEY;
const POSTMARK_TOKEN = process.env.POSTMARK_SERVER_TOKEN;
const FROM_EMAIL = 'paul@knightingale.com.au';

// ─── helpers ────────────────────────────────────────────────────────────────

function fmtTime(n) {
  if (n == null) return '';
  const s = String(Math.round(n)).padStart(4, '0');
  return `${s.slice(0, 2)}:${s.slice(2)}`;
}

function parseLocalDate(dateStr) {
  if (!dateStr) return new Date();
  // Bubble stores dates as UTC midnight AEST (14:00 UTC = 00:00 AEST next day)
  // Add 10 hours to convert UTC -> AEST before extracting date
  const d = new Date(new Date(dateStr).getTime() + 10 * 60 * 60 * 1000);
  return d;
}

function nextMondayAEST() {
  // "Now" in AEST (UTC+10), regardless of the server's own timezone
  const nowAest = new Date(Date.now() + 10 * 60 * 60 * 1000);
  const dow = nowAest.getUTCDay(); // 0=Sun, 1=Mon ... 6=Sat
  // Days until the NEXT Monday. On a Monday this returns 7 (next week, not today).
  const daysAhead = ((8 - dow) % 7) || 7;
  const target = new Date(Date.UTC(
    nowAest.getUTCFullYear(),
    nowAest.getUTCMonth(),
    nowAest.getUTCDate() + daysAhead
  ));
  const y = target.getUTCFullYear();
  const m = String(target.getUTCMonth() + 1).padStart(2, '0');
  const d = String(target.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function fmtDate(dateStr) {
  if (!dateStr) return '';
  const d = parseLocalDate(dateStr);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function dayName(dateStr) {
  if (!dateStr) return '';
  return parseLocalDate(dateStr).toLocaleDateString('en-AU', { weekday: 'short' });
}

function fmtMoney(n) {
  if (n == null) return '$0';
  return '$' + Number(n).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function weekRange(weekStart) {
  const d = new Date(weekStart);
  const end = new Date(d);
  end.setDate(d.getDate() + 6);
  return {
    label: `${fmtDate(d.toISOString())} – ${fmtDate(end.toISOString())}`,
    start: d,
    end,
  };
}

async function bubbleGet(path, params = {}) {
  const url = new URL(`${BUBBLE_BASE}/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${BUBBLE_KEY}` },
  });
  if (!res.ok) throw new Error(`Bubble ${path} ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── fetch data ──────────────────────────────────────────────────────────────

async function fetchParticipant(userId) {
  const data = await bubbleGet(`user/${userId}`);
  return data.response;
}

async function fetchShifts(participantId, weekStart, weekEnd) {
  // Bubble stores dates as AEST midnight = 14:00 UTC the previous day.
  // Build bounds in that same frame so the window is exactly Mon 00:00 -> Sun 23:59 AEST.
  const AEST_OFFSET_MS = 10 * 60 * 60 * 1000;
  const [ys, ms, ds] = weekStart.split('-').map(Number);
  const [ye, me, de] = weekEnd.split('-').map(Number);
  // Monday 00:00 AEST, expressed in UTC
  const lower = new Date(Date.UTC(ys, ms - 1, ds) - AEST_OFFSET_MS);
  // Sunday 23:59:59 AEST, expressed in UTC
  const upper = new Date(Date.UTC(ye, me - 1, de) - AEST_OFFSET_MS + 24 * 60 * 60 * 1000 - 1000);

  const constraints = JSON.stringify([
    { key: 'participant', constraint_type: 'equals', value: participantId },
    { key: 'date', constraint_type: 'greater than', value: new Date(lower.getTime() - 1000).toISOString() },
    { key: 'date', constraint_type: 'less than', value: upper.toISOString() },
  ]);
  const data = await bubbleGet('shift', { constraints, sort_field: 'date', ascending: 'true', limit: 50 });
  const shifts = data.response.results || [];

  // Bubble returns carer as a User ID string — expand each one
  const carerIds = [...new Set(shifts.map(s => s.carer).filter(c => c && typeof c === 'string'))];
  const carerMap = {};
  await Promise.all(carerIds.map(async (id) => {
    try {
      const u = await bubbleGet(`user/${id}`);
      carerMap[id] = u.response;
    } catch (_) {}
  }));

  return shifts.map(s => ({
    ...s,
    carerObj: typeof s.carer === 'string' ? (carerMap[s.carer] || null) : s.carer,
  }));
}

async function fetchNdisQuarter(participantId) {
  const constraints = JSON.stringify([
    { key: 'participant', constraint_type: 'equals', value: participantId },
  ]);
  const data = await bubbleGet('ndis quarter', {
    constraints,
    sort_field: 'Created Date',
    descending: 'true',
    limit: 1,
  });
  const results = data.response.results || [];
  return results[0] || null;
}

// ─── PDF generation ──────────────────────────────────────────────────────────

const CHERRY = '#681334';
const EUCALYPT = '#213530';
const SAND = '#f7f3f0';
const TEAL_BG = '#eef6f2';
const TEAL_TEXT = '#0F6E56';
const MUTED = '#888888';
const WHITE = '#ffffff';

function buildPdf(participant, shifts, quarter, weekLabel) {
  const fonts = {
    Helvetica: {
      normal: 'Helvetica',
      bold: 'Helvetica-Bold',
      italics: 'Helvetica-Oblique',
      bolditalics: 'Helvetica-BoldOblique',
    },
  };

  const printer = new PdfPrinter(fonts);

  const shiftRows = shifts.map(s => {
    const carerUser = s.carerObj;
    const carerName = carerUser
      ? `${carerUser['first name'] || ''} ${carerUser['last name'] || ''}`.trim()
      : 'TBC';
    return [
      { text: dayName(s.date), bold: true, alignment: 'center' },
      { text: fmtDate(s.date), alignment: 'center', color: '#555555' },
      { text: `${fmtTime(s['start time'])}–${fmtTime(s['end time'])}`, alignment: 'center', color: '#555555' },
      { text: String(s.hours ?? ''), alignment: 'center' },
      { text: carerName, alignment: 'center', italics: carerName === 'TBC', color: carerName === 'TBC' ? '#BA7517' : '#333333' },
    ];
  });


  const docDefinition = {
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 50],
    defaultStyle: { font: 'Helvetica', fontSize: 10 },
    content: [
      // ── Header ──
      {
        canvas: [{ type: 'rect', x: -40, y: -40, w: 595, h: 70, color: CHERRY }],
        margin: [0, 0, 0, 0],
      },
      {
        columns: [
          { text: 'Knightingale', color: WHITE, fontSize: 16, font: 'Helvetica', margin: [-40, -60, 0, 0] },
          {
            stack: [
              { text: 'Weekly Roster', color: WHITE, fontSize: 12, bold: true },
              { text: weekLabel, color: 'rgba(255,255,255,0.65)', fontSize: 9, margin: [0, 2, 0, 0] },
            ],
            alignment: 'center',
            margin: [0, -60, 0, 0],
          },
          { text: '', margin: [0, -60, -40, 0], width: 100 },
        ],
        margin: [0, 0, 0, 16],
      },

      // ── Meta band ──
      {
        table: {
          widths: ['*', '*'],
          body: [[
            {
              stack: [
                { text: 'PARTICIPANT', fontSize: 7, color: MUTED, bold: true, letterSpacing: 1 },
                { text: `${participant['first name'] || ''} ${participant['last name'] || ''}`.trim(), fontSize: 11, bold: true, margin: [0, 2, 0, 0] },
              ],
              alignment: 'center',
              fillColor: SAND,
              border: [false, false, false, false],
              margin: [0, 10, 0, 10],
            },
            {
              stack: [
                { text: 'NDIS NUMBER', fontSize: 7, color: MUTED, bold: true, letterSpacing: 1 },
                { text: participant['ndis number'] || '', fontSize: 11, bold: true, margin: [0, 2, 0, 0] },
              ],
              alignment: 'center',
              fillColor: SAND,
              border: [false, false, false, false],
              margin: [0, 10, 0, 10],
            },
          ]],
        },
        margin: [0, 0, 0, 16],
      },

      // ── Section head ──
      {
        canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1, lineColor: CHERRY }],
        margin: [0, 0, 0, 4],
      },
      { text: 'SHIFT SCHEDULE', fontSize: 8, color: CHERRY, bold: true, margin: [0, 0, 0, 8] },

      // ── Shift table ──
      {
        table: {
          headerRows: 1,
          widths: ['*', '*', '*', '*', '*'],
          body: [
            [
              { text: 'DAY', style: 'th' },
              { text: 'DATE', style: 'th' },
              { text: 'TIME', style: 'th' },
              { text: 'HRS', style: 'th' },
              { text: 'CARER', style: 'th' },
            ],
            ...shiftRows,
          ],
        },
        layout: {
          fillColor: (i) => i === 0 ? EUCALYPT : i % 2 === 0 ? '#f9f9f9' : null,
          hLineWidth: () => 0.5,
          vLineWidth: () => 0,
          hLineColor: () => '#ebebeb',
          paddingLeft: () => 6,
          paddingRight: () => 6,
          paddingTop: () => 6,
          paddingBottom: () => 6,
        },
      },
    ],
    styles: {
      th: { fontSize: 8, color: WHITE, bold: true, alignment: 'center' },
    },
    footer: {
      columns: [
        { text: `Knightingale · Melbourne, VIC\nGenerated ${fmtDate(new Date().toISOString())}`, fontSize: 8, color: 'rgba(255,255,255,0.6)', margin: [40, 10, 0, 0] },
        { text: `paul@knightingale.com.au\nknightingale.com.au`, fontSize: 8, color: '#7aab99', alignment: 'right', margin: [0, 10, 40, 0] },
      ],
      background: EUCALYPT,
      margin: [0, 0, 0, 0],
    },
  };

  return new Promise((resolve, reject) => {
    const doc = printer.createPdfKitDocument(docDefinition);
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

// ─── Email HTML ───────────────────────────────────────────────────────────────

function buildEmailHtml(participant, shifts, quarter, weekLabel) {

  const rows = shifts.map(s => {
    const carerUser = s.carerObj;
    const carerName = carerUser
      ? `${carerUser['first name'] || ''} ${carerUser['last name'] || ''}`.trim()
      : 'TBC';
    const isTbc = carerName === 'TBC';
    return `
      <tr>
        <td style="padding:9px 10px;border-bottom:1px solid #f0f0f0;text-align:center;font-weight:bold">${dayName(s.date)}</td>
        <td style="padding:9px 10px;border-bottom:1px solid #f0f0f0;text-align:center;color:#555">${fmtDate(s.date)}</td>
        <td style="padding:9px 10px;border-bottom:1px solid #f0f0f0;text-align:center;color:#555">${fmtTime(s['start time'])}–${fmtTime(s['end time'])}</td>
        <td style="padding:9px 10px;border-bottom:1px solid #f0f0f0;text-align:center">${s.hours ?? ''}</td>
        <td style="padding:9px 10px;border-bottom:1px solid #f0f0f0;text-align:center;${isTbc ? 'color:#BA7517;font-style:italic' : ''}">${carerName}</td>
      </tr>`;
  }).join('');

  const participantName = `${participant['first name'] || ''} ${participant['last name'] || ''}`.trim();

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;background:#e8e8e8">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:4px;overflow:hidden;border:1px solid #d0d0d0">

  <!-- header -->
  <tr><td style="background:#681334;padding:22px 28px">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="color:#fff;font-size:17px;font-weight:400;width:120px">Knightingale</td>
      <td style="text-align:center">
        <div style="color:#fff;font-size:13px;font-weight:bold">Weekly Roster</div>
        <div style="color:rgba(255,255,255,0.65);font-size:10px;margin-top:3px">${weekLabel}</div>
      </td>
      <td style="width:120px"></td>
    </tr></table>
  </td></tr>

  <!-- meta band -->
  <tr><td style="background:#f7f3f0;border-bottom:1px solid #e8e0dc;padding:12px 28px">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="text-align:center;width:50%">
        <div style="font-size:9px;text-transform:uppercase;letter-spacing:1px;color:#888;font-weight:bold;margin-bottom:2px">Participant</div>
        <div style="font-size:12px;color:#222;font-weight:bold">${participantName}</div>
      </td>
      <td style="text-align:center;width:50%">
        <div style="font-size:9px;text-transform:uppercase;letter-spacing:1px;color:#888;font-weight:bold;margin-bottom:2px">NDIS Number</div>
        <div style="font-size:12px;color:#222;font-weight:bold">${participant['ndis number'] || ''}</div>
      </td>
    </tr></table>
  </td></tr>

  <!-- body -->
  <tr><td style="padding:24px 28px">

    <p style="font-size:14px;color:#444;line-height:1.7;margin:0 0 14px">👋🙂</p>
    <p style="font-size:14px;color:#444;line-height:1.7;margin:0 0 20px">Please see ${participantName} roster attached for the ${weekLabel}.</p>

    <!-- shift table -->
    <div style="font-size:9px;text-transform:uppercase;letter-spacing:1px;color:#681334;font-weight:bold;margin-bottom:8px;padding-bottom:4px;border-bottom:1.5px solid #681334">Shift Schedule</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;border-collapse:collapse">
      <thead>
        <tr style="background:#213530">
          <th style="color:#fff;padding:8px;text-align:center;font-size:10px;font-weight:500;text-transform:uppercase;letter-spacing:1px">Day</th>
          <th style="color:#fff;padding:8px;text-align:center;font-size:10px;font-weight:500;text-transform:uppercase;letter-spacing:1px">Date</th>
          <th style="color:#fff;padding:8px;text-align:center;font-size:10px;font-weight:500;text-transform:uppercase;letter-spacing:1px">Time</th>
          <th style="color:#fff;padding:8px;text-align:center;font-size:10px;font-weight:500;text-transform:uppercase;letter-spacing:1px">Hrs</th>
          <th style="color:#fff;padding:8px;text-align:center;font-size:10px;font-weight:500;text-transform:uppercase;letter-spacing:1px">Carer</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>



  </td></tr>

  <!-- footer -->
  <tr><td style="background:#213530;padding:12px 28px">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="color:rgba(255,255,255,0.6);font-size:9px;line-height:1.6">Knightingale · Melbourne, VIC</td>
      <td style="color:#7aab99;font-size:9px;text-align:right">paul@knightingale.com.au</td>
    </tr></table>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  // If Vercel didn't parse it (string or undefined), parse manually
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  if (!body) body = {};

  console.log('PARSED BODY:', JSON.stringify(body));

  const { participant_id, to_email, cc_email } = body;

  if (!participant_id) {
    return res.status(400).json({ error: 'participant_id required', received: body });
  }

  // week_start is optional. Omit it and we use the COMING Monday (AEST).
  const week_start = body.week_start || nextMondayAEST();

  try {
    // week_start expected as YYYY-MM-DD
    const weekStartDate = new Date(week_start);
    const weekEndDate = new Date(weekStartDate);
    weekEndDate.setDate(weekStartDate.getDate() + 6);
    const weekEnd = weekEndDate.toISOString().split('T')[0];
    const { label: weekLabel } = weekRange(weekStartDate.toISOString());

    // Fetch from Bubble in parallel
    const [participant, shifts, quarter] = await Promise.all([
      fetchParticipant(participant_id),
      fetchShifts(participant_id, week_start, weekEnd),
      fetchNdisQuarter(participant_id),
    ]);

    const recipientEmail = to_email || participant.email;
    if (!recipientEmail) return res.status(400).json({ error: 'No recipient email' });

    const participantName = `${participant['first name'] || ''} ${participant['last name'] || ''}`.trim();
    const subject = `Weekly roster — ${participantName} — ${weekLabel.replace(' ', '')}`;

    // Build PDF and HTML in parallel
    const [pdfBuffer, htmlBody] = await Promise.all([
      buildPdf(participant, shifts, quarter, weekLabel),
      Promise.resolve(buildEmailHtml(participant, shifts, quarter, weekLabel)),
    ]);

    const pdfBase64 = pdfBuffer.toString('base64');
    const filename = `Knightingale_Roster_${participantName.replace(/\s+/g, '-')}_${week_start}.pdf`;

    // Send via Postmark
    const pmRes = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Postmark-Server-Token': POSTMARK_TOKEN,
      },
      body: JSON.stringify({
        From: FROM_EMAIL,
        To: recipientEmail,
        ...(cc_email ? { Cc: cc_email } : {}),
        Subject: subject,
        HtmlBody: htmlBody,
        Attachments: [{
          Name: filename,
          Content: pdfBase64,
          ContentType: 'application/pdf',
        }],
        MessageStream: 'outbound',
      }),
    });

    if (!pmRes.ok) {
      const err = await pmRes.text();
      throw new Error(`Postmark error: ${err}`);
    }

    return res.status(200).json({ ok: true, to: recipientEmail, subject });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}

const PdfPrinter = require('pdfmake');

const BUBBLE_BASE = 'https://knightingale.com.au/api/1.1/obj';
const BUBBLE_KEY = process.env.BUBBLE_API_KEY;
const POSTMARK_TOKEN = process.env.POSTMARK_SERVER_TOKEN;
const FROM_EMAIL = 'paul@knightingale.com.au';

// ─── helpers ────────────────────────────────────────────────────────────────

const MELB = 'Australia/Melbourne';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function fmtTime(n) {
  if (n == null) return '';
  const s = String(Math.round(n)).padStart(4, '0');
  return `${s.slice(0, 2)}:${s.slice(2)}`;
}

// 24hr number (e.g. 1300) -> "1:00 pm", 0 -> "12:00 am", 1230 -> "12:30 pm"
function to12h(n) {
  if (n == null) return '';
  const v = Math.round(n);
  let h = Math.floor(v / 100);
  const m = v % 100;
  const period = h >= 12 ? 'pm' : 'am';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, '0')} ${period}`;
}

// "10:00 am to 1:00 pm" — drops the am/pm on the start when it matches the end
function fmtTimeRange(start, end) {
  const s12 = to12h(start);
  const e12 = to12h(end);
  const sPeriod = s12.slice(-2);
  const ePeriod = e12.slice(-2);
  const startText = sPeriod === ePeriod ? s12.slice(0, -3) : s12;
  return `${startText} to ${e12}`;
}

// The calendar parts of an instant as seen in Melbourne. Uses the real timezone
// rules, so it is right on both sides of daylight saving (AEST +10 / AEDT +11)
// without any hardcoded offset.
function melbParts(input) {
  const d = input instanceof Date ? input : new Date(input);
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: MELB,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    weekday: get('weekday'),
  };
}

// The instant (as a Date) when Melbourne local time is exactly 00:00 on the given
// calendar day. Bubble stores each shift date as that instant. Tries AEDT (+11)
// first, then AEST (+10), and keeps whichever really lands on local midnight, so
// the day daylight saving starts or ends is handled too.
function melbourneMidnightUtc(y, m, d) {
  for (const offsetHours of [11, 10]) {
    const cand = new Date(Date.UTC(y, m - 1, d) - offsetHours * 60 * 60 * 1000);
    const p = melbParts(cand);
    if (p.year === y && p.month === m && p.day === d && p.hour === 0) return cand;
  }
  return new Date(Date.UTC(y, m - 1, d) - 10 * 60 * 60 * 1000);
}

function nextMondayAEST() {
  // Today's date in Melbourne, whatever timezone the server runs in
  const p = melbParts(new Date());
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(); // 0=Sun ... 6=Sat
  // Days until the NEXT Monday. On a Monday this returns 7 (next week, not today).
  const daysAhead = ((8 - dow) % 7) || 7;
  const target = new Date(Date.UTC(p.year, p.month - 1, p.day + daysAhead));
  const y = target.getUTCFullYear();
  const m = String(target.getUTCMonth() + 1).padStart(2, '0');
  const d = String(target.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// "06/07" style (kept for the filename and other short uses)
function fmtDate(dateStr) {
  if (!dateStr) return '';
  const p = melbParts(dateStr);
  return `${String(p.day).padStart(2, '0')}/${String(p.month).padStart(2, '0')}`;
}

// "5 Oct" from a Bubble shift instant (Melbourne day)
function fmtDayMonth(dateStr) {
  if (!dateStr) return '';
  const p = melbParts(dateStr);
  return `${p.day} ${MONTHS[p.month - 1]}`;
}

// "Monday" from a Bubble shift instant (Melbourne day)
function fmtWeekdayLong(dateStr) {
  if (!dateStr) return '';
  const p = melbParts(dateStr);
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return WEEKDAYS_LONG[dow];
}

function dayName(dateStr) {
  if (!dateStr) return '';
  return melbParts(dateStr).weekday;
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

// "Monday 5 Oct to Sunday 11 Oct" from two YYYY-MM-DD strings
function weekRangeLong(weekStartStr, weekEndStr) {
  const [ys, ms, ds] = weekStartStr.split('-').map(Number);
  const [ye, me, de] = weekEndStr.split('-').map(Number);
  const startDow = new Date(Date.UTC(ys, ms - 1, ds)).getUTCDay();
  const endDow = new Date(Date.UTC(ye, me - 1, de)).getUTCDay();
  return `${WEEKDAYS_LONG[startDow]} ${ds} ${MONTHS[ms - 1]} to ${WEEKDAYS_LONG[endDow]} ${de} ${MONTHS[me - 1]}`;
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
  // Bubble stores each shift date as Melbourne midnight, which is 13:00 UTC the day
  // before in daylight saving and 14:00 UTC in standard time. Build the window from
  // real Melbourne midnights so it is exactly Mon 00:00 to the end of Sun, in either
  // season. (A fixed +10 offset made Monday shifts drop out and the following
  // Monday's shifts creep in after daylight saving started.)
  const [ys, ms, ds] = weekStart.split('-').map(Number);
  const [ye, me, de] = weekEnd.split('-').map(Number);
  const lower = melbourneMidnightUtc(ys, ms, ds);
  const dayAfterEnd = new Date(Date.UTC(ye, me - 1, de + 1));
  // Start of the day AFTER the week ends, exclusive, so all of Sunday is included
  const upper = melbourneMidnightUtc(
    dayAfterEnd.getUTCFullYear(),
    dayAfterEnd.getUTCMonth() + 1,
    dayAfterEnd.getUTCDate()
  );

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

// ─── shared derivations ────────────────────────────────────────────────────────

function carerNameOf(s) {
  const c = s.carerObj;
  return c ? `${c['first name'] || ''} ${c['last name'] || ''}`.trim() : 'TBC';
}

function computeStats(shifts) {
  const totalHours = shifts.reduce((acc, s) => acc + (Number(s.hours) || 0), 0);
  const shiftCount = shifts.length;
  const carers = new Set(shifts.map(carerNameOf).filter(n => n && n !== 'TBC'));
  const carerCount = carers.size;
  // Tidy the hours number: drop trailing .0
  const totalHoursText = Number.isInteger(totalHours) ? String(totalHours) : totalHours.toFixed(2).replace(/\.?0+$/, '');
  return { totalHoursText, shiftCount, carerCount };
}

// ─── PDF generation ──────────────────────────────────────────────────────────

const NAVY = '#1e2a4a';
const SLATE = '#6b748a';
const SLATE_LIGHT = '#8a93a6';
const HAIRLINE = '#d8d5cd';
const ROW_LINE = '#e5e2da';
const INK = '#28324d';

function buildPdf(participant, shifts, weekRangeText, stats) {
  const fonts = {
    Helvetica: {
      normal: 'Helvetica',
      bold: 'Helvetica-Bold',
      italics: 'Helvetica-Oblique',
      bolditalics: 'Helvetica-BoldOblique',
    },
    Times: {
      normal: 'Times-Roman',
      bold: 'Times-Bold',
      italics: 'Times-Italic',
      bolditalics: 'Times-BoldItalic',
    },
  };

  const printer = new PdfPrinter(fonts);
  const participantName = `${participant['first name'] || ''} ${participant['last name'] || ''}`.trim();

  const shiftRows = shifts.map((s, i) => {
    const carerName = carerNameOf(s);
    const isTbc = carerName === 'TBC';
    const topBorder = i === 0 ? [false, false, false, false] : [false, true, false, false];
    return [
      {
        text: [
          { text: fmtWeekdayLong(s.date) + ' ', bold: true, color: INK },
          { text: fmtDayMonth(s.date), color: SLATE_LIGHT },
        ],
        border: topBorder,
        margin: [0, 15, 0, 15],
      },
      { text: fmtTimeRange(s['start time'], s['end time']), color: INK, border: topBorder, margin: [0, 15, 0, 15] },
      { text: carerName, color: isTbc ? '#BA7517' : INK, italics: isTbc, border: topBorder, margin: [0, 15, 0, 15] },
      { text: String(s.hours ?? ''), alignment: 'right', color: INK, border: topBorder, margin: [0, 15, 0, 15] },
    ];
  });

  const hr = (space) => ({
    canvas: [{ type: 'line', x1: 0, y1: 0, x2: 475, y2: 0, lineWidth: 1.2, lineColor: NAVY }],
    margin: [0, space[0], 0, space[1]],
  });

  const docDefinition = {
    pageSize: 'A4',
    pageMargins: [60, 56, 60, 56],
    defaultStyle: { font: 'Helvetica', fontSize: 10, color: INK },
    content: [
      // ── Top row: logo + WEEKLY ROSTER ──
      {
        columns: [
          { text: 'Knightingale', font: 'Times', fontSize: 26, color: NAVY, width: '*' },
          { text: 'WEEKLY ROSTER', font: 'Helvetica', fontSize: 9, color: SLATE_LIGHT, bold: true, characterSpacing: 1.5, alignment: 'right', margin: [0, 12, 0, 0] },
        ],
      },
      hr([20, 22]),

      // ── Date range + name + NDIS ──
      { text: weekRangeText.toUpperCase(), fontSize: 9.5, color: SLATE_LIGHT, bold: true, characterSpacing: 1.2, margin: [0, 0, 0, 8] },
      { text: participantName, font: 'Times', fontSize: 34, color: NAVY, margin: [0, 0, 0, 10] },
      { text: `NDIS number ${participant['ndis number'] || ''}`, fontSize: 11, color: SLATE, margin: [0, 0, 0, 0] },

      hr([24, 22]),

      // ── Stats row: three evenly-spread hero figures ──
      {
        columns: [
          {
            width: '*',
            text: [
              { text: stats.totalHoursText, font: 'Times', fontSize: 40, color: NAVY },
              { text: ' hrs', font: 'Times', fontSize: 18, color: SLATE },
            ],
          },
          {
            width: '*',
            alignment: 'center',
            text: [
              { text: String(stats.shiftCount), font: 'Times', fontSize: 40, color: NAVY },
              { text: ` shift${stats.shiftCount === 1 ? '' : 's'}`, font: 'Times', fontSize: 18, color: SLATE },
            ],
          },
          {
            width: '*',
            alignment: 'right',
            text: [
              { text: String(stats.carerCount), font: 'Times', fontSize: 40, color: NAVY },
              { text: ` carer${stats.carerCount === 1 ? '' : 's'}`, font: 'Times', fontSize: 18, color: SLATE },
            ],
          },
        ],
      },

      hr([24, 22]),

      // ── Shift schedule ──
      { text: 'SHIFT SCHEDULE', fontSize: 9.5, color: SLATE_LIGHT, bold: true, characterSpacing: 1.2, margin: [0, 0, 0, 12] },
      {
        table: {
          headerRows: 1,
          widths: ['*', '*', '*', 40],
          body: [
            [
              { text: 'DAY', style: 'th' },
              { text: 'TIME', style: 'th' },
              { text: 'CARER', style: 'th' },
              { text: 'HRS', style: 'th', alignment: 'right' },
            ],
            ...shiftRows,
          ],
        },
        layout: {
          hLineWidth: (i) => (i === 1 ? 0 : 0.8),
          vLineWidth: () => 0,
          hLineColor: () => ROW_LINE,
          paddingLeft: () => 0,
          paddingRight: () => 0,
          paddingTop: () => 0,
          paddingBottom: () => 0,
        },
      },
    ],
    styles: {
      th: { fontSize: 8.5, color: SLATE_LIGHT, bold: true, characterSpacing: 1, margin: [0, 0, 0, 10] },
    },
    footer: {
      margin: [60, 20, 60, 0],
      columns: [
        { text: 'Knightingale, Melbourne VIC', fontSize: 10, color: SLATE_LIGHT, width: '*' },
        { text: 'paul@knightingale.com.au', fontSize: 10, color: NAVY, alignment: 'right' },
      ],
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

function buildEmailHtml(participant, shifts, weekRangeText, stats) {
  const participantName = `${participant['first name'] || ''} ${participant['last name'] || ''}`.trim();

  const rows = shifts.map((s, i) => {
    const carerName = carerNameOf(s);
    const isTbc = carerName === 'TBC';
    const topBorder = i === 0 ? '' : 'border-top:1px solid #e5e2da;';
    return `
      <tr>
        <td style="padding:24px 0;${topBorder}font-size:14px;color:#28324d"><strong>${fmtWeekdayLong(s.date)}</strong> <span style="color:#8a93a6">${fmtDayMonth(s.date)}</span></td>
        <td style="padding:24px 0;${topBorder}font-size:14px;color:#28324d">${fmtTimeRange(s['start time'], s['end time'])}</td>
        <td style="padding:24px 0;${topBorder}font-size:14px;${isTbc ? 'color:#BA7517;font-style:italic' : 'color:#28324d'}">${carerName}</td>
        <td style="padding:24px 0;${topBorder}font-size:14px;color:#28324d;text-align:right;font-weight:500">${s.hours ?? ''}</td>
      </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;background:#ebe9e4;color:#1e2a4a">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px">
<table width="580" cellpadding="0" cellspacing="0" style="background:#fff;max-width:580px;border-radius:10px;overflow:hidden">
  <tr><td style="padding:48px 56px 40px">

    <!-- top row -->
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-family:Georgia,'Times New Roman',serif;font-size:28px;color:#1e2a4a;letter-spacing:0.5px">Knightingale</td>
      <td style="font-size:10px;letter-spacing:0.15em;color:#8a93a6;font-weight:bold;text-align:right;vertical-align:bottom">WEEKLY ROSTER</td>
    </tr></table>

    <div style="border-top:1.5px solid #1e2a4a;margin:20px 0"></div>

    <!-- date range + name + ndis -->
    <div style="font-size:11px;letter-spacing:0.12em;color:#8a93a6;font-weight:bold;text-transform:uppercase;margin-bottom:8px">${weekRangeText}</div>
    <div style="font-family:Georgia,'Times New Roman',serif;font-size:36px;color:#1e2a4a;line-height:1.05;margin-bottom:12px">${participantName}</div>
    <div style="font-size:13px;color:#6b748a">NDIS number ${participant['ndis number'] || ''}</div>

    <div style="border-top:1.5px solid #1e2a4a;margin:24px 0"></div>

    <!-- stats row -->
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-family:Georgia,'Times New Roman',serif;font-size:40px;color:#1e2a4a;line-height:1;text-align:left">${stats.totalHoursText}<span style="font-size:18px;color:#6b748a">&nbsp;hrs</span></td>
      <td style="font-family:Georgia,'Times New Roman',serif;font-size:40px;color:#1e2a4a;line-height:1;text-align:center">${stats.shiftCount}<span style="font-size:18px;color:#6b748a">&nbsp;shift${stats.shiftCount === 1 ? '' : 's'}</span></td>
      <td style="font-family:Georgia,'Times New Roman',serif;font-size:40px;color:#1e2a4a;line-height:1;text-align:right">${stats.carerCount}<span style="font-size:18px;color:#6b748a">&nbsp;carer${stats.carerCount === 1 ? '' : 's'}</span></td>
    </tr></table>

    <div style="border-top:1.5px solid #1e2a4a;margin:24px 0"></div>

    <!-- shift schedule -->
    <div style="font-size:11px;letter-spacing:0.12em;color:#8a93a6;font-weight:bold;text-transform:uppercase;margin-bottom:14px">Shift Schedule</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
      <thead>
        <tr>
          <th style="font-size:10px;letter-spacing:0.1em;color:#8a93a6;font-weight:bold;text-transform:uppercase;text-align:left;padding-bottom:10px">Day</th>
          <th style="font-size:10px;letter-spacing:0.1em;color:#8a93a6;font-weight:bold;text-transform:uppercase;text-align:left;padding-bottom:10px">Time</th>
          <th style="font-size:10px;letter-spacing:0.1em;color:#8a93a6;font-weight:bold;text-transform:uppercase;text-align:left;padding-bottom:10px">Carer</th>
          <th style="font-size:10px;letter-spacing:0.1em;color:#8a93a6;font-weight:bold;text-transform:uppercase;text-align:right;padding-bottom:10px">Hrs</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <div style="border-top:1px solid #d8d5cd;margin:28px 0 20px"></div>

    <!-- footer -->
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-size:12px;color:#8a93a6">Knightingale, Melbourne VIC</td>
      <td style="font-size:12px;color:#1e2a4a;text-align:right">paul@knightingale.com.au</td>
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
    const weekRangeText = weekRangeLong(week_start, weekEnd);

    // Fetch from Bubble in parallel
    const [participant, shifts] = await Promise.all([
      fetchParticipant(participant_id),
      fetchShifts(participant_id, week_start, weekEnd),
    ]);

    const recipientEmail = to_email || participant.email;
    if (!recipientEmail) return res.status(400).json({ error: 'No recipient email' });

    const participantName = `${participant['first name'] || ''} ${participant['last name'] || ''}`.trim();
    const stats = computeStats(shifts);

    // Subject: "Weekly roster — Johanna Houston — 5 Oct to 11 Oct"
    const [ys, ms, ds] = week_start.split('-').map(Number);
    const [ye, me, de] = weekEnd.split('-').map(Number);
    const subject = `Weekly roster — ${participantName} — ${ds} ${MONTHS[ms - 1]} to ${de} ${MONTHS[me - 1]}`;

    // Build PDF and HTML in parallel
    const [pdfBuffer, htmlBody] = await Promise.all([
      buildPdf(participant, shifts, weekRangeText, stats),
      Promise.resolve(buildEmailHtml(participant, shifts, weekRangeText, stats)),
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

import qrcode from 'qrcode-generator';
import type { CertificatePayload, CertificateRow } from './certificate';
import { formatVerificationCode } from './certificate';
import { Font, PdfDocument, PdfPage, Rgb, wrap } from './pdf';

// The certificate as a PDF for the patient's chart: the same content as the
// on-screen certificate, a QR code that opens its verification page, and the
// exact signed record attached, so it can be checked without this server.

const BLUE: Rgb = [56, 88, 214];
const TEXT: Rgb = [27, 36, 64];
const MUTED: Rgb = [110, 118, 140];
const BORDER: Rgb = [220, 225, 238];
const SOFT: Rgb = [235, 239, 255];
const GOLD: Rgb = [201, 162, 39];
const WHITE: Rgb = [255, 255, 255];

const M = 54;            // page margin
const W = 612 - 2 * M;   // content width
const BOTTOM = 740;      // content ends here; the footer is below

const dateFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', dateStyle: 'long', timeStyle: 'short' });
const shortFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' });
const when = (iso: string) => `${dateFmt.format(new Date(iso))} UTC`;
const whenShort = (iso: string) => `${shortFmt.format(new Date(iso))} UTC`;
const duration = (s: number) => `${Math.floor(Math.round(s) / 60)}:${String(Math.round(s) % 60).padStart(2, '0')}`;

export function certificatePdf(row: CertificateRow, appOrigin: string): Uint8Array {
  const c = JSON.parse(row.payload) as CertificatePayload;
  const code = formatVerificationCode(row.verification_code);
  const verifyUrl = `${appOrigin}/verify/${code}`;
  const doc = new PdfDocument({
    title: `Certificate of Completion ${code}`,
    author: 'Aurelius Code',
    subject: `${c.procedure.name} — ${c.patient.name}`,
    created: new Date(c.issued_at),
  });

  // A gold frame, like the on-screen certificate's border.
  const newPage = () => {
    const p = doc.addPage();
    p.rect(18, 18, 576, 756, { stroke: GOLD, lineWidth: 2 });
    p.rect(23, 23, 566, 746, { stroke: GOLD, lineWidth: 0.5 });
    return p;
  };
  let page = newPage();
  let y = 0;
  const footer = (p: PdfPage) => p.text(306, 760, `Aurelius Code · Certificate ${code} · Check it at ${verifyUrl}`, { size: 7.5, color: MUTED, align: 'center' });
  const ensure = (h: number) => {
    if (y + h <= BOTTOM) return;
    footer(page);
    page = newPage();
    y = M;
  };
  const centered = (s: string, font: Font, size: number, color: Rgb, gap: number) => {
    for (const line of wrap(s, font, size, W)) {
      y += size;
      page.text(306, y, line, { font, size, color, align: 'center' });
      y += gap;
    }
  };

  // Header band and title.
  page.rect(M, 36, W, 56, { fill: BLUE, radius: 10 });
  page.text(306, 72, 'AURELIUS CODE', { font: 'B', size: 20, color: WHITE, align: 'center', spacing: 2 });
  y = 116;
  centered('Certificate of Completion', 'B', 26, TEXT, 10);
  page.line(306 - 60, y, 306 + 60, y, GOLD, 2);
  y += 18;

  centered('This certifies that', 'R', 11, MUTED, 6);
  centered(c.patient.name, 'B', 22, TEXT, 8);
  if (c.acknowledgment) {
    centered('watched every video, answered its questions, and confirmed they understand', 'R', 11, MUTED, 2);
    centered('the information prescribed for', 'R', 11, MUTED, 6);
  } else {
    centered('watched every video prescribed for', 'R', 11, MUTED, 6);
  }
  centered(c.procedure.name, 'B', 16, BLUE, 6);
  centered(`Prescribed by ${c.prescribed_by.name}. Completed ${when(c.completed_at)}.`, 'R', 10, MUTED, 14);

  // The videos.
  const hasQuestions = !!c.acknowledgment;
  const cols: Array<{ label: string; w: number; align?: 'right' }> = [
    { label: '#', w: 28 },
    { label: 'Video', w: hasQuestions ? 160 : 220 },
    { label: 'Length', w: 48 },
    { label: 'Completed', w: 122 },
    { label: 'Checks passed', w: 72 },
    ...(hasQuestions ? [{ label: 'Questions', w: 74 }] : []),
  ];
  const pad = 6;
  const header = () => {
    page.rect(M, y, W, 22, { fill: SOFT, radius: 4 });
    let x = M;
    for (const col of cols) {
      page.text(x + pad, y + 14.5, col.label, { font: 'B', size: 8.5, color: TEXT });
      x += col.w;
    }
    y += 22;
  };
  ensure(60);
  header();
  for (const v of c.videos) {
    const cells = [
      String(v.order),
      v.title,
      duration(v.duration_seconds),
      whenShort(v.completed_at),
      String(v.watch.attention_checks_passed),
      ...(hasQuestions ? [v.understanding?.questions ? `${v.understanding.questions} of ${v.understanding.questions} correct` : '—'] : []),
    ];
    const wrapped = cells.map((s, i) => wrap(s, 'R', 9, cols[i].w - 2 * pad));
    const h = Math.max(...wrapped.map((l) => l.length)) * 12 + 10;
    if (y + h > BOTTOM) {
      ensure(h + 40);
      header();
    }
    let x = M;
    wrapped.forEach((lines, i) => {
      lines.forEach((line, j) => page.text(x + pad, y + 15 + j * 12, line, { size: 9, color: TEXT }));
      x += cols[i].w;
    });
    y += h;
    page.line(M, y, M + W, y, BORDER, 0.75);
  }
  y += 18;

  // The facts behind it.
  const facts: Array<[string, string]> = [
    ['Identity', `Verified by one-time code sent to ${c.patient.identity_verification.destination}`],
    ['Pacing', `Each video was released by the server no faster than real time, so it could not be skipped. Skip attempts: ${c.total_seek_attempts} stopped by the player, ${c.total_seek_blocked} refused by the server.`],
  ];
  if (c.acknowledgment) {
    const total = c.videos.reduce((n, v) => n + (v.understanding?.questions ?? 0), 0);
    const first = c.videos.reduce((n, v) => n + (v.understanding?.first_try_correct ?? 0), 0);
    facts.push(
      ['Understanding', `After each video the patient answered questions on its key points; every question was answered correctly before the next video unlocked (${first} of ${total} right the first time).`],
      ['Confirmed', `“${c.acknowledgment.statement}” · ${when(c.acknowledgment.acknowledged_at)}${c.acknowledgment.asked_doctor_a_question ? ' · The patient sent their doctor a question.' : ''}`],
    );
  }
  facts.push(['Record', `Signed (Ed25519, key ${c.signature.key_id}); audit log of ${c.audit_log.event_count} events. The signed record is attached to this PDF as certificate-signed.json.`]);
  const labelW = 92;
  for (const [label, value] of facts) {
    const lines = wrap(value, 'R', 9.5, W - labelW);
    ensure(lines.length * 13 + 8);
    page.text(M, y + 10, label.toUpperCase(), { font: 'B', size: 8, color: MUTED, spacing: 0.6 });
    lines.forEach((line, i) => page.text(M + labelW, y + 10 + i * 13, line, { size: 9.5, color: TEXT }));
    y += lines.length * 13 + 8;
  }

  // Verification code, QR code and seal.
  ensure(120);
  y += 10;
  page.rect(M, y, W, 104, { stroke: BORDER, radius: 10, lineWidth: 1 });
  page.text(M + 18, y + 24, 'VERIFICATION CODE', { font: 'B', size: 8, color: MUTED, spacing: 0.6 });
  page.text(M + 18, y + 50, code, { font: 'B', size: 20, color: TEXT, spacing: 1 });
  const hint = wrap(`Scan the code or visit ${verifyUrl} to confirm this certificate is genuine and unchanged.`, 'R', 8.5, 270);
  hint.forEach((line, i) => page.text(M + 18, y + 70 + i * 11, line, { size: 8.5, color: MUTED }));
  qr(page, verifyUrl, M + W - 196, y + 12, 80);
  page.circle(M + W - 58, y + 52, 38, { fill: BLUE });
  page.circle(M + W - 58, y + 52, 33, { stroke: WHITE, lineWidth: 1 });
  page.check(M + W - 58, y + 44, 18, WHITE, 3);
  page.text(M + W - 58, y + 70, 'VERIFIED', { font: 'B', size: 7, color: WHITE, align: 'center', spacing: 1 });
  y += 104;
  footer(page);

  doc.attach({
    name: 'certificate-signed.json',
    mime: 'application/json',
    description: 'The signed certificate record. POST it to /api/verify to check the signature.',
    data: new TextEncoder().encode(JSON.stringify({ payload: row.payload, signature: row.signature }, null, 2)),
  });
  return doc.toBytes();
}

function qr(page: PdfPage, text: string, x: number, y: number, size: number) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  const cell = size / n;
  page.rect(x - 4, y - 4, size + 8, size + 8, { fill: WHITE });
  // Each row's dark modules as runs, slightly overlapping the next row, so
  // readers show no hairline gaps.
  for (let r = 0; r < n; r++) {
    for (let col = 0; col < n; col++) {
      if (!q.isDark(r, col)) continue;
      let end = col;
      while (end + 1 < n && q.isDark(r, end + 1)) end++;
      page.rect(x + col * cell, y + r * cell, (end - col + 1) * cell, cell + (r + 1 < n ? 0.3 : 0), { fill: TEXT });
      col = end;
    }
  }
}

export function certificatePdfResponse(row: CertificateRow, appOrigin: string): Response {
  return new Response(certificatePdf(row, appOrigin), {
    headers: {
      'Content-Type': 'application/pdf',
      // The file name carries the code, not the patient's name.
      'Content-Disposition': `attachment; filename="certificate-${formatVerificationCode(row.verification_code)}.pdf"`,
      'Cache-Control': 'private, no-store',
    },
  });
}

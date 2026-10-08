import { describe, expect, it } from 'vitest';
import { Client, captureEmails, prescribe, verifiedPatient, watchAndComplete } from './helpers';

async function finished(setup?: (s: Awaited<ReturnType<typeof prescribe>>) => Promise<void>) {
  const s = await prescribe({ videos: 1, duration: 12 });
  if (setup) await setup(s);
  const p = await verifiedPatient(s.token, s.patientEmail);
  return { s, p };
}

// The attached signed record, read back out of the PDF.
function attachedRecord(pdf: string) {
  const m = /\/Type \/EmbeddedFile[^]*?stream\n([^]*?)\nendstream/.exec(pdf);
  return JSON.parse(m![1]);
}

describe('certificate PDF', () => {
  it('downloads for the patient and the doctor once issued, with the signed record attached', async () => {
    const { s, p } = await finished();
    expect((await p.fetch(`/api/watch/${s.token}/certificate.pdf`)).status).toBe(409);
    expect((await s.doctorClient.fetch(`/api/doctor/prescriptions/${s.prescriptionId}/certificate.pdf`)).status).toBe(409);
    await watchAndComplete(p, s.token, s.prescriptionId, s.videoIds[0]);

    const res = await p.fetch(`/api/watch/${s.token}/certificate.pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment; filename="certificate-AUR-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}\.pdf"$/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const pdf = new TextDecoder('latin1').decode(bytes);
    expect(pdf.startsWith('%PDF-1.7')).toBe(true);
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    // The cross-reference table points at each object.
    const xref = Number(/startxref\n(\d+)/.exec(pdf)![1]);
    expect(pdf.slice(xref, xref + 4)).toBe('xref');
    const offsets = [...pdf.slice(xref).matchAll(/(\d{10}) 00000 n /g)].map((m) => Number(m[1]));
    expect(offsets.length).toBeGreaterThan(5);
    offsets.forEach((off, i) => expect(pdf.slice(off, off + 12)).toContain(`${i + 1} 0 obj`));

    // The attachment is the exact signed record, and it verifies.
    const record = attachedRecord(pdf);
    const cert: any = await (await p.fetch(`/api/watch/${s.token}/certificate`)).json();
    expect(record).toEqual({ payload: cert.payload, signature: cert.signature });
    expect(await (await new Client().post('/api/verify', record)).json()).toEqual({ signature_valid: true, matches_record: true });

    const doc = await s.doctorClient.fetch(`/api/doctor/prescriptions/${s.prescriptionId}/certificate.pdf`);
    expect(doc.status).toBe(200);
    expect(attachedRecord(new TextDecoder('latin1').decode(await doc.arrayBuffer()))).toEqual(record);
    // Not for anyone else.
    expect((await new Client().fetch(`/api/watch/${s.token}/certificate.pdf`)).status).toBe(401);
    const other = await prescribe({ videos: 1 });
    expect((await other.doctorClient.fetch(`/api/doctor/prescriptions/${s.prescriptionId}/certificate.pdf`)).status).toBe(404);
  });

  it('tells the office when a certificate is ready, naming only initials', async () => {
    const { s, p } = await finished(async (s) => {
      expect((await s.doctorClient.post('/api/doctor/team/certificate-email', { email: 'not an email' })).status).toBe(400);
      expect((await s.doctorClient.post('/api/doctor/team/certificate-email', { email: 'Office@Clinic.test' })).status).toBe(200);
      expect(await (await s.doctorClient.fetch('/api/doctor/team')).json()).toMatchObject({ certificateEmail: 'office@clinic.test' });
    });
    const emails = captureEmails();
    try {
      await watchAndComplete(p, s.token, s.prescriptionId, s.videoIds[0]);
      const sent = emails.lastTo('office@clinic.test')!;
      expect(sent.subject).toBe('Certificate ready (J. S.)');
      expect(sent.text).toContain(`/doctor/patients/${s.prescriptionId}`);
      expect(sent.text).not.toContain('Jane');
      expect(sent.text).not.toContain('Smith');
      // Issued once, sent once.
      await p.fetch(`/api/watch/${s.token}/certificate`);
      expect(emails.sent.filter((e) => e.to === 'office@clinic.test')).toHaveLength(1);
    } finally {
      emails.restore();
    }

    // Clearing the address stops the notices.
    const { s: s2, p: p2 } = await finished(async (s2) => {
      await s2.doctorClient.post('/api/doctor/team/certificate-email', { email: 'office@clinic.test' });
      await s2.doctorClient.post('/api/doctor/team/certificate-email', { email: '' });
    });
    const again = captureEmails();
    try {
      await watchAndComplete(p2, s2.token, s2.prescriptionId, s2.videoIds[0]);
      expect(again.lastTo('office@clinic.test')).toBeUndefined();
    } finally {
      again.restore();
    }
  });
});

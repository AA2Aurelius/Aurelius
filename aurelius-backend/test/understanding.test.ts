import { describe, expect, it } from 'vitest';
import { acknowledge, captureEmails, env, events, loginDoctor, playVideo, prescribe, seedDoctor, verifiedPatient, watchAndComplete } from './helpers';

async function seedQuestions(videoId: string) {
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO video_questions (id, video_id, position, prompt, choices, correct_index, explanation, created_at) VALUES (?, ?, 1, ?, ?, 1, ?, ?)`)
      .bind(ids[0], videoId, 'Can a new hip dislocate?', JSON.stringify(['No, never', 'Yes, in rare cases']), 'The video explains that dislocation is rare but possible.', new Date().toISOString()),
    env.DB.prepare(`INSERT INTO video_questions (id, video_id, position, prompt, choices, correct_index, created_at) VALUES (?, ?, 2, ?, ?, 0, ?)`)
      .bind(ids[1], videoId, 'Will you need physical therapy?', JSON.stringify(['Yes', 'No']), new Date().toISOString()),
  ]);
  return ids;
}

describe('understanding questions', () => {
  it('keep the next video locked until answered correctly, and go on the certificate', async () => {
    const s = await prescribe({ videos: 2, duration: 30 });
    const [q1, q2] = await seedQuestions(s.videoIds[0]);
    const p = await verifiedPatient(s.token, s.patientEmail);
    const base = `/api/watch/${s.token}`;

    // Not before the video is watched.
    expect((await p.post(`${base}/video/${s.videoIds[0]}/questions/${q1}/answer`, { choice: 1 })).status).toBe(409);

    await watchAndComplete(p, s.token, s.prescriptionId, s.videoIds[0]);
    let portal: any = await (await p.fetch(base)).json();
    expect(portal.videos[0]).toMatchObject({ watched: true, complete: false, questions_pending: true, question_count: 2 });
    expect(portal.videos[1].unlocked).toBe(false);
    expect((await p.post(`${base}/video/${s.videoIds[1]}/playback`)).status).toBe(403);

    // The right answers stay on the server.
    const qs: any = await (await p.fetch(`${base}/video/${s.videoIds[0]}/questions`)).json();
    expect(qs.questions).toHaveLength(2);
    expect(JSON.stringify(qs)).not.toContain('correct_index');

    // A wrong answer explains; the patient tries again.
    let r: any = await (await p.post(`${base}/video/${s.videoIds[0]}/questions/${q1}/answer`, { choice: 0 })).json();
    expect(r).toMatchObject({ correct: false, understood: false, explanation: expect.stringContaining('rare') });
    r = await (await p.post(`${base}/video/${s.videoIds[0]}/questions/${q1}/answer`, { choice: 1 })).json();
    expect(r).toMatchObject({ correct: true, understood: false });
    expect((await p.post(`${base}/video/${s.videoIds[0]}/questions/${q2}/answer`, { choice: 9 })).status).toBe(400);
    r = await (await p.post(`${base}/video/${s.videoIds[0]}/questions/${q2}/answer`, { choice: 0 })).json();
    expect(r).toMatchObject({ correct: true, understood: true });

    portal = await (await p.fetch(base)).json();
    expect(portal.videos[0].complete).toBe(true);
    expect(portal.videos[1].unlocked).toBe(true);

    // The acknowledgment needs every video done, and the box ticked.
    expect((await acknowledge(p, s.token)).status).toBe(409);
    await watchAndComplete(p, s.token, s.prescriptionId, s.videoIds[1], { acknowledge: false });
    expect((await p.fetch(`${base}/certificate`)).status).toBe(409);
    expect((await p.post(`${base}/acknowledge`, { understand: false })).status).toBe(400);

    const emails = captureEmails();
    try {
      const ack: any = await (await acknowledge(p, s.token, 'How long until I can drive?')).json();
      expect(ack).toMatchObject({ acknowledged: true, certified: true });
      // The doctor is told there's a question, but not what it says.
      const note = emails.lastTo(s.doctor.email)!;
      expect(note.subject).toContain('J. Q. S.');
      expect(note.text).not.toContain('drive');
      expect(note.text).toContain(`/doctor/patients/${s.prescriptionId}`);
    } finally {
      emails.restore();
    }

    const cert: any = await (await p.fetch(`${base}/certificate`)).json();
    expect(cert.certificate.version).toBe(3);
    expect(cert.certificate.videos[0].understanding).toEqual({ questions: 2, attempts: 3, first_try_correct: 1 });
    expect(cert.certificate.videos[1].understanding).toEqual({ questions: 0, attempts: 0, first_try_correct: 0 });
    expect(cert.certificate.acknowledgment).toMatchObject({ statement_version: 1, asked_doctor_a_question: true });
    expect((await p.post('/api/verify', { payload: cert.payload, signature: cert.signature })).status).toBe(200);

    const types = (await events(s.prescriptionId)).map((e) => e.event_type);
    expect(types.filter((t) => t === 'question_answered')).toHaveLength(3);
    expect(types).toEqual(expect.arrayContaining(['understood', 'acknowledged', 'patient_question', 'certificate_issued']));
    expect(types.indexOf('acknowledged')).toBeLessThan(types.indexOf('certificate_issued'));

    // The doctor sees the answers and the question, and can mark it answered.
    const detail: any = await (await s.doctorClient.fetch(`/api/doctor/prescriptions/${s.prescriptionId}`)).json();
    expect(detail.videos[0].questions).toEqual([
      expect.objectContaining({ position: 1, attempts: 2, correct: true, wrong_answers: ['No, never'], answer: 'Yes, in rare cases' }),
      expect.objectContaining({ position: 2, attempts: 1, correct: true, wrong_answers: [] }),
    ]);
    expect(detail.patient_questions).toEqual([expect.objectContaining({ question: 'How long until I can drive?', answered_at: null })]);
    const list: any = await (await s.doctorClient.fetch('/api/doctor/patients')).json();
    expect(list.find((x: any) => x.id === s.prescriptionId).open_questions).toBe(1);

    const other = await loginDoctor(await seedDoctor());
    const qid = detail.patient_questions[0].id;
    expect((await other.post(`/api/doctor/prescriptions/${s.prescriptionId}/questions/${qid}/answered`)).status).toBe(404);
    expect((await s.doctorClient.post(`/api/doctor/prescriptions/${s.prescriptionId}/questions/${qid}/answered`)).status).toBe(200);
    const after: any = await (await s.doctorClient.fetch('/api/doctor/patients')).json();
    expect(after.find((x: any) => x.id === s.prescriptionId).open_questions).toBe(0);
  });

  it('a video without questions unlocks the next as soon as it is watched', async () => {
    const s = await prescribe({ videos: 2, duration: 30 });
    const p = await verifiedPatient(s.token, s.patientEmail);
    const { state } = await playVideo(p, s.token, s.videoIds[0]);
    expect(state.completed).toBe(true);
    const portal: any = await (await p.fetch(`/api/watch/${s.token}`)).json();
    expect(portal.videos[0]).toMatchObject({ complete: true, questions_pending: false, question_count: 0 });
    expect(portal.videos[1].unlocked).toBe(true);
    expect(portal.acknowledged).toBe(false);
    expect(portal.acknowledgment).toContain('I understand');
  });
});

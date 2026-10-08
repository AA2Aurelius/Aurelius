import type { Hono } from 'hono';
import { logEvent, prepareEvent, withChainRetry } from './audit';
import { issueCertificateIfComplete } from './certificate';
import { sendEmail } from './email';
import { Env, clientIp, nowIso, uuid } from './lib';
import { overLimit } from './ratelimit';
import { AppEnv, getPrescribedVideo, readJson, requireActiveLink, requirePatient } from './routes/common';

// Understanding questions after each video, and the patient's closing
// acknowledgment. A video counts as done (and unlocks the next) only when
// it has been watched in full AND each of its questions has been answered
// correctly; the certificate is issued only after the acknowledgment.

// What the patient confirms before the certificate is issued. A change of
// wording gets a new version, recorded with each acknowledgment.
export const ACKNOWLEDGMENT = {
  version: 1,
  statement:
    'I have watched all of these videos. I understand what my procedure involves, its main risks and benefits, ' +
    'and the alternatives. I know I can ask my doctor any questions before I sign my consent form.',
};

const MAX_PATIENT_QUESTION = 2000;

export interface QuestionRow {
  id: string;
  video_id: string;
  position: number;
  prompt: string;
  choices: string;
  correct_index: number;
  explanation: string | null;
}

export async function activeQuestions(env: Env, videoId: string): Promise<QuestionRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, video_id, position, prompt, choices, correct_index, explanation FROM video_questions
     WHERE video_id = ? AND retired_at IS NULL ORDER BY position`
  ).bind(videoId).all<QuestionRow>();
  return results;
}

// Per video: how many questions, how many answers it took, and how many
// were right the first time. Questions are counted from the answers, so a
// question retired after the patient answered it still counts.
export async function understandingByVideo(env: Env, prescriptionId: string): Promise<Map<string, { questions: number; attempts: number; first_try_correct: number }>> {
  const { results } = await env.DB.prepare(
    `SELECT video_id, question_id, correct, answered_at FROM question_answers WHERE prescription_id = ? ORDER BY answered_at, rowid`
  ).bind(prescriptionId).all<{ video_id: string; question_id: string; correct: number }>();
  const byVideo = new Map<string, { questions: number; attempts: number; first_try_correct: number }>();
  const seen = new Set<string>();
  for (const a of results) {
    const v = byVideo.get(a.video_id) ?? { questions: 0, attempts: 0, first_try_correct: 0 };
    v.attempts++;
    if (!seen.has(a.question_id)) {
      seen.add(a.question_id);
      v.questions++;
      if (a.correct) v.first_try_correct++;
    }
    byVideo.set(a.video_id, v);
  }
  return byVideo;
}

// Marks a watched video understood once every active question has a correct
// answer (immediately, if it has none). Returns true when it is understood.
export async function markUnderstoodIfReady(env: Env, prescriptionId: string, videoId: string, ip: string | null): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT completed_at, understood_at FROM video_progress WHERE prescription_id = ? AND video_id = ?`
  ).bind(prescriptionId, videoId).first<{ completed_at: string | null; understood_at: string | null }>();
  if (!row?.completed_at) return false;
  if (row.understood_at) return true;
  const open = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM video_questions q
     WHERE q.video_id = ? AND q.retired_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM question_answers a WHERE a.question_id = q.id AND a.prescription_id = ? AND a.correct = 1)`
  ).bind(videoId, prescriptionId).first<{ n: number }>();
  if ((open?.n ?? 0) > 0) return false;
  const set = await env.DB.prepare(`UPDATE video_progress SET understood_at = ? WHERE prescription_id = ? AND video_id = ? AND understood_at IS NULL`)
    .bind(nowIso(), prescriptionId, videoId).run();
  // Logged only for a video that had questions; for one without, its
  // "complete" event already says everything.
  const counts = set.meta.changes === 1 ? (await understandingByVideo(env, prescriptionId)).get(videoId) : undefined;
  if (counts) await logEvent(env, { prescriptionId, videoId, type: 'understood', ip, meta: { ...counts } });
  return true;
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).map((w) => `${w[0].toUpperCase()}.`).join(' ');
}

export function registerUnderstandingRoutes(app: Hono<AppEnv>) {
  // The questions for a watched video. The right answers stay on the server.
  app.get('/:token/video/:videoId/questions', requirePatient, async (c) => {
    const p = c.get('prescription');
    const video = await getPrescribedVideo(c.env, p.id, c.req.param('videoId'));
    if (!video) return c.json({ error: 'Not found.' }, 404);
    if (!video.completed_at) return c.json({ error: 'Watch the whole video first.' }, 409);
    const questions = await activeQuestions(c.env, video.video_id);
    const { results: right } = await c.env.DB.prepare(
      `SELECT DISTINCT question_id FROM question_answers WHERE prescription_id = ? AND video_id = ? AND correct = 1`
    ).bind(p.id, video.video_id).all<{ question_id: string }>();
    const done = new Set(right.map((r) => r.question_id));
    return c.json({
      videoTitle: video.title,
      understood: await markUnderstoodIfReady(c.env, p.id, video.video_id, clientIp(c.req.raw)),
      questions: questions.map((q) => ({ id: q.id, position: q.position, prompt: q.prompt, choices: JSON.parse(q.choices) as string[], answered: done.has(q.id) })),
    });
  });

  app.post('/:token/video/:videoId/questions/:questionId/answer', requireActiveLink, requirePatient, async (c) => {
    const p = c.get('prescription');
    const ip = clientIp(c.req.raw);
    if (await overLimit(c.env, `answers:${c.get('patient').sessionId}`, 60, 60)) return c.json({ error: 'Too many answers. Please wait a moment.' }, 429);
    const video = await getPrescribedVideo(c.env, p.id, c.req.param('videoId'));
    if (!video) return c.json({ error: 'Not found.' }, 404);
    if (!video.completed_at) return c.json({ error: 'Watch the whole video first.' }, 409);
    const q = await c.env.DB.prepare(
      `SELECT id, video_id, position, prompt, choices, correct_index, explanation FROM video_questions WHERE id = ? AND video_id = ? AND retired_at IS NULL`
    ).bind(c.req.param('questionId'), video.video_id).first<QuestionRow>();
    if (!q) return c.json({ error: 'This question is no longer in use. Please reload the page.' }, 404);
    const body = await readJson(c);
    const choices = JSON.parse(q.choices) as string[];
    const choice = body.choice;
    if (typeof choice !== 'number' || !Number.isInteger(choice) || choice < 0 || choice >= choices.length) {
      return c.json({ error: 'Choose one of the answers.' }, 400);
    }

    const already = await c.env.DB.prepare(`SELECT 1 FROM question_answers WHERE prescription_id = ? AND question_id = ? AND correct = 1`)
      .bind(p.id, q.id).first();
    const correct = choice === q.correct_index;
    if (!already) {
      const prior = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM question_answers WHERE prescription_id = ? AND question_id = ?`)
        .bind(p.id, q.id).first<{ n: number }>();
      const answerId = uuid();
      await withChainRetry(
        () => prepareEvent(c.env, {
          prescriptionId: p.id, videoId: video.video_id, type: 'question_answered', ip,
          meta: { question: q.id, position: q.position, choice, correct, attempt: (prior?.n ?? 0) + 1 },
        }),
        async (ev) => {
          await c.env.DB.batch([
            c.env.DB.prepare(
              `INSERT INTO question_answers (id, prescription_id, video_id, question_id, chosen_index, correct, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
            ).bind(answerId, p.id, video.video_id, q.id, choice, correct ? 1 : 0, nowIso()),
            ev.stmt,
          ]);
        }
      );
    }
    const understood = correct || already ? await markUnderstoodIfReady(c.env, p.id, video.video_id, ip) : false;
    return c.json({ correct, explanation: correct ? null : q.explanation, understood });
  });

  // The closing acknowledgment, with an optional question for the doctor.
  // Issues the certificate.
  app.post('/:token/acknowledge', requireActiveLink, requirePatient, async (c) => {
    const p = c.get('prescription');
    const ip = clientIp(c.req.raw);
    const body = await readJson(c);
    if (body.understand !== true) return c.json({ error: 'Please tick the box to confirm you understand.' }, 400);
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (question.length > MAX_PATIENT_QUESTION) return c.json({ error: `Please keep your question under ${MAX_PATIENT_QUESTION} characters.` }, 400);

    const open = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM video_progress WHERE prescription_id = ? AND (completed_at IS NULL OR understood_at IS NULL)`
    ).bind(p.id).first<{ n: number }>();
    if ((open?.n ?? 1) > 0) return c.json({ error: 'Please finish every video and its questions first.' }, 409);

    const ack = await c.env.DB.prepare(`UPDATE prescriptions SET acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL`)
      .bind(nowIso(), p.id).run();
    if (ack.meta.changes === 1) {
      await logEvent(c.env, { prescriptionId: p.id, type: 'acknowledged', ip, meta: { statement_version: ACKNOWLEDGMENT.version, asked_question: !!question } });
    }

    if (question && ack.meta.changes === 1) {
      const id = uuid();
      await c.env.DB.prepare(`INSERT INTO patient_questions (id, prescription_id, question, created_at) VALUES (?, ?, ?, ?)`)
        .bind(id, p.id, question, nowIso()).run();
      await logEvent(c.env, { prescriptionId: p.id, type: 'patient_question', ip, meta: { question_id: id, length: question.length } });
      // The email names no procedure details or question text: the doctor
      // reads it in the portal.
      const doc = await c.env.DB.prepare(
        `SELECT d.email, proc.name AS procedure_name FROM doctors d JOIN procedures proc ON proc.id = ? WHERE d.id = ?`
      ).bind(p.procedure_id, p.doctor_id).first<{ email: string; procedure_name: string }>();
      if (doc) {
        try {
          await sendEmail(c.env, {
            to: doc.email,
            subject: `A patient has a question (${initials(p.patient_name)})`,
            text:
              `Your patient ${initials(p.patient_name)} has finished their ${doc.procedure_name} videos and sent you a question.\n\n` +
              `Sign in to read it: ${c.env.APP_ORIGIN}/doctor/patients/${encodeURIComponent(p.id)}`,
          });
          await c.env.DB.prepare(`UPDATE patient_questions SET doctor_notified_at = ? WHERE id = ?`).bind(nowIso(), id).run();
        } catch (err) {
          console.error('patient question email failed', err);
        }
      }
    }

    let certified = false;
    try {
      certified = !!(await issueCertificateIfComplete(c.env, p.id));
    } catch (err) {
      console.error('certificate issuance failed', err);
    }
    return c.json({ acknowledged: true, certified });
  });
}

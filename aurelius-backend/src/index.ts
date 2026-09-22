import { Hono } from 'hono';
import { logEvent } from './audit';
import { sendEmail } from './email';
import { Env, hoursFromNow, hoursUntil, nowIso } from './lib';
import type { AppEnv } from './routes/common';
import { doctor } from './routes/doctor';
import { patient } from './routes/patient';
import { verify } from './routes/verify';

// The frontend and this API share one origin (APP_ORIGIN); the API lives
// under /api so it doesn't collide with frontend pages like /watch/{token}.
const app = new Hono<AppEnv>();

app.use('*', async (c, next) => {
  await next();
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Content-Type-Options', 'nosniff');
});

// Cross-site request forgery guard for anything that changes state. Session
// cookies are SameSite=Strict already; this also rejects any browser request
// that says it came from another origin.
app.use('/api/*', async (c, next) => {
  const method = c.req.method;
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const origin = c.req.header('Origin');
    if ((origin && origin !== c.env.APP_ORIGIN) || c.req.header('Sec-Fetch-Site') === 'cross-site') {
      return c.json({ error: 'Cross-origin request rejected.' }, 403);
    }
  }
  await next();
});

app.route('/api/doctor', doctor);
app.route('/api/watch', patient);
app.route('/api/verify', verify);

app.notFound((c) => c.json({ error: 'Not found.' }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Something went wrong.' }, 500);
});

// =====================================================================
// CRON: 12h-remaining reminders to both patient and doctor
// =====================================================================

export async function runReminderSweep(env: Env): Promise<void> {
  const threshold = Number(env.REMINDER_HOURS_BEFORE_EXPIRY || 12);
  const now = nowIso();

  // Only links that are live, inside the reminder window, not yet reminded
  // and not yet finished.
  const { results } = await env.DB.prepare(
    `SELECT pr.id, pr.patient_name, pr.patient_email, pr.expires_at,
            d.name AS doctor_name, d.email AS doctor_email, proc.name AS procedure_name,
            (SELECT COUNT(*) FROM video_progress vp WHERE vp.prescription_id = pr.id AND vp.completed_at IS NOT NULL) AS videos_done,
            (SELECT COUNT(*) FROM video_progress vp WHERE vp.prescription_id = pr.id) AS videos_total
     FROM prescriptions pr
     JOIN doctors d ON d.id = pr.doctor_id
     JOIN procedures proc ON proc.id = pr.procedure_id
     WHERE pr.reminder_12h_sent_at IS NULL AND pr.revoked_at IS NULL
       AND pr.expires_at > ? AND pr.expires_at <= ?
       AND EXISTS (SELECT 1 FROM video_progress vp WHERE vp.prescription_id = pr.id AND vp.completed_at IS NULL)`
  ).bind(now, hoursFromNow(threshold)).all<any>();

  for (const p of results) {
    // Claim first, so overlapping cron runs can't both send.
    const claimed = await env.DB.prepare(`UPDATE prescriptions SET reminder_12h_sent_at = ? WHERE id = ? AND reminder_12h_sent_at IS NULL`)
      .bind(nowIso(), p.id).run();
    if (claimed.meta.changes !== 1) continue;

    const hoursLeft = Math.max(1, Math.round(hoursUntil(p.expires_at)));
    const delivery: Record<string, string> = {};
    const attempt = async (who: string, fn: () => Promise<void>) => {
      try {
        await fn();
        delivery[who] = 'sent';
      } catch (err) {
        console.error(`reminder to ${who} failed for ${p.id}`, err);
        delivery[who] = 'failed';
      }
    };

    // The link itself can't be included: only its hash is stored.
    await attempt('patient', () => sendEmail(env, {
      to: p.patient_email,
      subject: `Reminder: your ${p.procedure_name} videos expire in about ${hoursLeft} hours`,
      text:
        `Hello ${p.patient_name},\n\nYou've watched ${p.videos_done} of ${p.videos_total} videos from ${p.doctor_name}. ` +
        `Your link expires in about ${hoursLeft} hours. Please open the link in your original email to finish.`,
    }));
    await attempt('doctor', () => sendEmail(env, {
      to: p.doctor_email,
      subject: `${p.patient_name} hasn't finished their ${p.procedure_name} videos`,
      text: `${p.patient_name} has watched ${p.videos_done} of ${p.videos_total} videos. Their link expires in about ${hoursLeft} hours.`,
    }));
    await logEvent(env, { prescriptionId: p.id, type: 'reminder_12h', meta: delivery });
  }
}

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runReminderSweep(env));
  },
} satisfies ExportedHandler<Env>;

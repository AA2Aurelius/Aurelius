import { sendEmail } from './email';
import { Env, hoursFromNow, nowIso, randomToken, sha256Hex } from './lib';
import { INVITE_DAYS } from './routes/accounts';

// Invitations queued from the command line (npm run create-doctor --
// --invite). The script can't send email, so the 15-minute job turns each
// request into an account invitation and emails its link. The person invited
// chooses their own password on the same join page staff use.

const MAX_ATTEMPTS = 5;

export async function sendRequestedInvites(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.practice_id, r.name, r.email, r.role, r.attempts, p.name AS practice_name
     FROM invite_requests r JOIN practices p ON p.id = r.practice_id
     WHERE r.sent_at IS NULL AND r.attempts < ? ORDER BY r.created_at LIMIT 20`
  ).bind(MAX_ATTEMPTS).all<{ id: string; practice_id: string; name: string; email: string; role: string; attempts: number; practice_name: string }>();

  for (const r of results) {
    // Claim first, so overlapping runs can't both send.
    const claimed = await env.DB.prepare(`UPDATE invite_requests SET attempts = attempts + 1 WHERE id = ? AND sent_at IS NULL AND attempts = ?`)
      .bind(r.id, r.attempts).run();
    if (claimed.meta.changes !== 1) continue;

    const taken = await env.DB.prepare(`SELECT 1 FROM doctors WHERE email = ? COLLATE NOCASE`).bind(r.email).first();
    if (taken) {
      await env.DB.prepare(`UPDATE invite_requests SET sent_at = ?, outcome = 'account already exists' WHERE id = ?`).bind(nowIso(), r.id).run();
      continue;
    }

    const token = randomToken();
    const inviteId = await sha256Hex(token);
    await env.DB.prepare(
      `INSERT INTO account_invites (id, practice_id, name, email, role, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`
    ).bind(inviteId, r.practice_id, r.name, r.email, r.role, nowIso(), hoursFromNow(INVITE_DAYS * 24)).run();
    try {
      await sendEmail(env, {
        to: r.email,
        subject: `Your Aurelius Code account for ${r.practice_name}`,
        text:
          `Hello ${r.name},\n\nYour Aurelius Code account for ${r.practice_name} is ready. ` +
          `Choose your password here to start (the link works for ${INVITE_DAYS} days and can be used once):\n` +
          `${env.APP_ORIGIN}/doctor/join/${token}\n\n` +
          `After that, sign in any time at ${env.APP_ORIGIN}/doctor.\n\n` +
          `If you weren't expecting this, you can ignore this email.`,
      });
      await env.DB.prepare(`UPDATE invite_requests SET sent_at = ?, outcome = 'sent' WHERE id = ?`).bind(nowIso(), r.id).run();
    } catch (err) {
      // The link was never delivered: withdraw it, and retry on a later run.
      console.error(`invite request ${r.id}: email failed`, err);
      await env.DB.prepare(`DELETE FROM account_invites WHERE id = ?`).bind(inviteId).run();
      await env.DB.prepare(`UPDATE invite_requests SET outcome = ? WHERE id = ?`).bind(`email failed (attempt ${r.attempts + 1})`, r.id).run();
    }
  }
}

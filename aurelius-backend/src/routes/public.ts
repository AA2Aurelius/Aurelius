import { Hono } from 'hono';
import { sendEmail } from '../email';
import { clientIp, isEmail, nowIso, uuid } from '../lib';
import { overLimit } from '../ratelimit';
import { turnstilePasses } from '../turnstile';
import { AppEnv, readJson } from './common';
import { registerEvergreenRoutes } from './evergreen';

// Routes anyone can use without signing in: the evergreen explainer videos
// ("Brain Science", "How It Works"), so the home page can play them, and the
// contact form. Procedure videos stay behind a doctor or patient sign-in.
export const publicRoutes = new Hono<AppEnv>();

registerEvergreenRoutes(publicRoutes, '/evergreen');

const LIMITS = { name: 200, email: 254, organization: 200, topic: 120, message: 5000 };

function field(body: Record<string, unknown>, key: keyof typeof LIMITS): string {
  const v = body[key];
  return typeof v === 'string' ? v.trim() : '';
}

// The home page's "Contact us" / "Sign up" form. Stored first, then emailed
// to CONTACT_TO (with Reply-To set to the sender), so a failed email loses
// nothing.
publicRoutes.post('/contact', async (c) => {
  const ip = clientIp(c.req.raw);
  if (await overLimit(c.env, `contact:${ip ?? 'unknown'}`, 5, 3600)) {
    return c.json({ error: 'Too many messages from here. Please try again later.' }, 429);
  }
  const body = await readJson(c);
  const msg = {
    name: field(body, 'name'),
    email: field(body, 'email'),
    organization: field(body, 'organization'),
    topic: field(body, 'topic'),
    message: field(body, 'message'),
  };
  if (!msg.name || !msg.message) return c.json({ error: 'Please give your name and a message.' }, 400);
  if (!isEmail(msg.email)) return c.json({ error: 'Please give a valid email address.' }, 400);
  for (const [k, max] of Object.entries(LIMITS)) {
    if (msg[k as keyof typeof msg].length > max) return c.json({ error: `The ${k} is too long.` }, 400);
  }
  if (!(await turnstilePasses(c.env, body.turnstileToken, ip))) {
    return c.json({ error: 'The bot check failed. Please try again.' }, 400);
  }

  const id = uuid();
  await c.env.DB.prepare(
    `INSERT INTO contact_messages (id, created_at, name, email, organization, topic, message, client_ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, nowIso(), msg.name, msg.email, msg.organization || null, msg.topic || null, msg.message, ip).run();

  if (c.env.CONTACT_TO) {
    try {
      await sendEmail(c.env, {
        to: c.env.CONTACT_TO,
        replyTo: msg.email,
        subject: `Aurelius Code contact: ${msg.topic || 'General'} — ${msg.name}`.slice(0, 200),
        text: [
          `From: ${msg.name} <${msg.email}>`,
          msg.organization ? `Organization: ${msg.organization}` : null,
          `About: ${msg.topic || 'General'}`,
          '',
          msg.message,
          '',
          'Reply to this email to answer them.',
        ].filter((l) => l !== null).join('\n'),
      });
      await c.env.DB.prepare(`UPDATE contact_messages SET emailed_at = ? WHERE id = ?`).bind(nowIso(), id).run();
    } catch (err) {
      // Kept in contact_messages; the sender still gets a normal answer.
      console.error(`contact message ${id} not emailed:`, err);
    }
  } else {
    console.warn(`contact message ${id} stored; CONTACT_TO is not set, so it wasn't emailed`);
  }
  return c.json({ ok: true });
});

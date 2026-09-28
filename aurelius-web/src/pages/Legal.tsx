// The Privacy Policy and Terms of Use. They describe what the service
// actually does; have them reviewed by a lawyer before relying on them.

const UPDATED = 'September 28, 2026';

export function PrivacyPage() {
  return (
    <article className="card legal">
      <h1>Privacy Policy</h1>
      <p className="muted">Last updated {UPDATED}</p>

      <h2>Who we are</h2>
      <p>
        Aurelius Code ("we", "us") provides short educational videos that doctors send to their patients before a procedure,
        and a signed certificate showing the patient watched them. This policy explains what information we handle and why.
        We handle patient information on behalf of the doctor or practice that sends the videos.
      </p>

      <h2>Information we collect</h2>
      <ul>
        <li><strong>Doctors:</strong> name, email address and a securely hashed password, plus sign-in records (time, IP address and browser).</li>
        <li><strong>Patients:</strong> the name and email address your doctor's office entered when inviting you, and the procedure you were invited to learn about.</li>
        <li><strong>Identity check:</strong> the one-time code we email you (stored only in scrambled, hashed form) and when you confirmed it.</li>
        <li><strong>Viewing record:</strong> which videos you watched and when, how far you got, pauses, attempts to skip ahead, answers to "are you still watching?" checks, and the IP address and browser used.</li>
        <li><strong>Certificate:</strong> once every video is watched, a signed certificate with your name, the procedure, your doctor, and when each video was completed.</li>
        <li><strong>Contact form:</strong> the name, email address, organization and message you send us, and your IP address.</li>
      </ul>

      <h2>How we use it</h2>
      <ul>
        <li>To send you your videos and confirm it's you watching them.</li>
        <li>To show your doctor your progress, and to issue and verify your certificate.</li>
        <li>To send reminders before your link expires.</li>
        <li>To keep the service secure, for example by limiting repeated sign-in attempts.</li>
        <li>To answer messages sent through our contact form.</li>
      </ul>
      <p>We do not sell personal information, and we do not use it for advertising.</p>

      <h2>Who can see it</h2>
      <ul>
        <li><strong>Your doctor's office</strong> sees your name, email, progress and certificate.</li>
        <li><strong>Anyone with your certificate's verification code</strong> can confirm it is genuine and see only the procedure, the completion date and your initials.</li>
        <li><strong>Service providers</strong> who run parts of the service for us: Cloudflare (hosting, database, video storage and bot protection) and Resend (email delivery). They may process information only to provide those services.</li>
        <li>Authorities, where the law requires it.</li>
      </ul>

      <h2>Cookies</h2>
      <p>
        We use only the cookies needed to keep you signed in. We do not use advertising or tracking cookies. Our bot check
        (Cloudflare Turnstile) may process technical information about your browser to tell people from bots.
      </p>

      <h2>How long we keep it</h2>
      <p>
        Viewing records and certificates form part of your informed-consent record, so they are kept, unchanged, for as
        long as that record may be needed and as the law requires. Patient links expire after 48 hours. Contact-form
        messages are kept for as long as needed to answer and follow up on them.
      </p>

      <h2>Security</h2>
      <p>
        Information travels over encrypted connections. Links, passwords and one-time codes are stored only in hashed form,
        each certificate is digitally signed, and the viewing record cannot be edited or deleted once written.
      </p>

      <h2>Your choices</h2>
      <p>
        For questions about your information, or to ask to see or correct it, contact your doctor's office or reach us
        through the <a href="/#contact">contact form</a>. Some records must be kept unchanged as part of your medical record.
      </p>

      <h2>Changes</h2>
      <p>If we change this policy, we'll update the date at the top of this page.</p>
    </article>
  );
}

export function TermsPage() {
  return (
    <article className="card legal">
      <h1>Terms of Use</h1>
      <p className="muted">Last updated {UPDATED}</p>

      <h2>The service</h2>
      <p>
        Aurelius Code lets doctors send patients short videos about their procedure, records that the patient watched every
        video, and issues a signed certificate when they have. By using the service you agree to these terms.
      </p>

      <h2>Not medical advice</h2>
      <p>
        The videos are general education. They do not replace a conversation with your doctor, and they are not advice about
        your own care. Ask your doctor about anything you don't understand, and call emergency services in an emergency.
      </p>

      <h2>For doctors and practices</h2>
      <ul>
        <li>You remain responsible for obtaining your patient's informed consent. The certificate records that the videos were watched; it is not consent by itself.</li>
        <li>Invite only your own patients, using contact details they gave you, and keep your password to yourself.</li>
        <li>You are responsible for activity under your account. Tell us promptly if you think someone else has used it.</li>
      </ul>

      <h2>For patients</h2>
      <ul>
        <li>Your link is personal. Don't share it, and watch the videos yourself; the service checks that someone is watching.</li>
        <li>Your link works for 48 hours. If it expires, ask your doctor's office for a new one.</li>
      </ul>

      <h2>Acceptable use</h2>
      <p>
        Don't try to get around the playback controls, access anyone else's information, interfere with the service, or copy
        and redistribute the videos. The videos and the Aurelius Code name and logo belong to us or our licensors.
      </p>

      <h2>Availability and changes</h2>
      <p>
        We work to keep the service running and secure, but it may sometimes be unavailable. We may change or improve the
        service and these terms; the date at the top shows when they last changed.
      </p>

      <h2>Limits of liability</h2>
      <p>
        To the extent the law allows, the service is provided as is, and we are not liable for indirect or consequential
        losses. Nothing in these terms limits rights you have under law that cannot be limited.
      </p>

      <h2>Contact</h2>
      <p>Questions about these terms: use our <a href="/#contact">contact form</a>.</p>
    </article>
  );
}

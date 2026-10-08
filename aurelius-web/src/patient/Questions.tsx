import { useEffect, useState } from 'react';
import { ApiError, api } from '../api';
import type { PortalVideo } from './Portal';

interface Question { id: string; position: number; prompt: string; choices: string[]; answered: boolean }

// The short questions after a video, one at a time. A wrong answer shows
// why, and the patient tries again; the next video unlocks once every
// question has been answered correctly.
export function Questions({ token, video, total, onDone, onRewatch, onBack }: {
  token: string;
  video: PortalVideo;
  total: number;
  onDone: () => void;     // all answered: carry on
  onRewatch: () => void;  // watch this video again
  onBack: () => void;
}) {
  const base = `/api/watch/${encodeURIComponent(token)}/video/${encodeURIComponent(video.id)}/questions`;
  const [questions, setQuestions] = useState<Question[] | null>(null);
  const [error, setError] = useState('');
  const [choice, setChoice] = useState<number | null>(null);
  const [result, setResult] = useState<{ correct: boolean; explanation: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ questions: Question[]; understood: boolean }>(base)
      .then((r) => (r.understood ? onDone() : setQuestions(r.questions)))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the questions.'));
  }, [base]);
  // Every question already answered (e.g. on another device): carry on.
  useEffect(() => {
    if (questions && questions.every((x) => x.answered)) onDone();
  }, [questions]);

  if (error) return <div className="card"><p className="error">{error}</p><button className="link-button" onClick={onBack}>← Your videos</button></div>;
  if (!questions) return <div className="center"><div className="spinner" aria-label="Loading" /></div>;

  const open = questions.filter((q) => !q.answered);
  const q = open[0];
  const doneCount = questions.length - open.length;
  if (!q) return <div className="center"><div className="spinner" aria-label="Loading" /></div>;

  const submit = async () => {
    if (choice === null) return;
    setBusy(true);
    setError('');
    try {
      const r = await api<{ correct: boolean; explanation: string | null; understood: boolean }>(`${base}/${encodeURIComponent(q.id)}/answer`, { json: { choice } });
      setResult(r);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send your answer.');
    } finally {
      setBusy(false);
    }
  };
  const next = () => {
    if (!result?.correct) {
      setResult(null);
      setChoice(null);
      return;
    }
    setResult(null);
    setChoice(null);
    setQuestions(questions.map((x) => (x.id === q.id ? { ...x, answered: true } : x)));
  };

  return (
    <section className="card questions-card stack" aria-labelledby="q-title">
      <button className="link-button" onClick={onBack}>← Your videos</button>
      <p className="continue-kicker">Video {video.order_index} of {total} · Question {doneCount + 1} of {questions.length}</p>
      <div className="q-progress" aria-hidden="true">{questions.map((x, i) => <span key={x.id} className={x.answered ? 'done' : i === doneCount ? 'now' : ''} />)}</div>
      <h2 id="q-title" className="q-prompt">{q.prompt}</h2>
      <fieldset className="q-choices" disabled={busy || !!result}>
        <legend className="sr-only">Choose one answer</legend>
        {q.choices.map((c, i) => (
          <label key={i} className={`q-choice ${choice === i ? 'chosen' : ''} ${result && choice === i ? (result.correct ? 'right' : 'wrong') : ''}`}>
            <input type="radio" name={`q-${q.id}`} checked={choice === i} onChange={() => setChoice(i)} />
            <span className="q-letter" aria-hidden="true">{'ABCDE'[i]}</span>
            <span>{c}</span>
          </label>
        ))}
      </fieldset>
      {result ? (
        result.correct ? (
          <div className="banner success" role="status"><p><strong>✓ That's right.</strong></p></div>
        ) : (
          <div className="banner warning" role="status">
            <p><strong>Not quite.</strong> {result.explanation ?? 'Have another look and try again.'}</p>
          </div>
        )
      ) : null}
      {error && <p className="error">{error}</p>}
      <div className="q-actions">
        {result ? (
          <button className="button big" onClick={next} autoFocus>
            {result.correct ? (open.length > 1 ? 'Next question' : 'Continue') : 'Try again'}
          </button>
        ) : (
          <button className="button big" onClick={submit} disabled={choice === null || busy}>{busy ? 'Checking…' : 'Check my answer'}</button>
        )}
        <button className="link-button" onClick={onRewatch}>Watch this video again</button>
      </div>
      <p className="note">These questions make sure the important points are clear. Your doctor can see your answers.</p>
    </section>
  );
}

// The last step before the certificate: the patient confirms they
// understand, and can send their doctor a question.
export function Acknowledge({ token, statement, onDone, onBack }: { token: string; statement: string; onDone: () => void; onBack: () => void }) {
  const [agree, setAgree] = useState(false);
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await api(`/api/watch/${encodeURIComponent(token)}/acknowledge`, { json: { understand: true, question: asking ? question.trim() : '' } });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      setBusy(false);
    }
  };

  return (
    <section className="card ack-card stack" aria-labelledby="ack-title">
      <button className="link-button" onClick={onBack}>← Your videos</button>
      <p className="continue-kicker">One last step</p>
      <h2 id="ack-title" style={{ margin: 0 }}>Please confirm you understand</h2>
      <label className="ack-statement">
        <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
        <span>{statement}</span>
      </label>
      <label className="ack-ask">
        <input type="checkbox" checked={asking} onChange={(e) => setAsking(e.target.checked)} />
        <span>I have a question for my doctor</span>
      </label>
      {asking && (
        <div className="field">
          <label htmlFor="ack-question">Your question</label>
          <textarea id="ack-question" rows={4} maxLength={2000} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="For example: How long until I can drive?" />
          <p className="note">Your doctor's office is told you have a question and reads it in their portal.</p>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <button className="button big" onClick={submit} disabled={!agree || busy || (asking && !question.trim())}>
        {busy ? 'Saving…' : 'Confirm and get my certificate'}
      </button>
    </section>
  );
}

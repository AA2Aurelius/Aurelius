// The Aurelius Code wordmark, in the green-and-gold of the logo in the
// videos: green letters with a gold outline and a slight 3D shadow.
export function Wordmark({ small }: { small?: boolean }) {
  return (
    <span className={`wordmark ${small ? 'small' : ''}`} aria-label="Aurelius Code">
      <span aria-hidden="true"><span className="wm-a">A</span>urelius Code</span>
    </span>
  );
}

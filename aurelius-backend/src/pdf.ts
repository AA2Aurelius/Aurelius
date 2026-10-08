// A small PDF writer: enough for a one- or two-page certificate with text in
// the standard Helvetica fonts, lines, boxes, circles and an attached file.
// No dependencies, so it runs in the Worker. Coordinates are in points from
// the top-left corner of the page (y grows downward).

export type Font = 'R' | 'B';
export type Rgb = [number, number, number];

// Advance widths (per 1000 em) of Helvetica and Helvetica-Bold, for
// characters 32-126. Other characters use an average width.
const WIDTHS: Record<Font, number[]> = {
  R: [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584],
  B: [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584],
};

// WinAnsiEncoding: Latin-1 maps to itself; these are the extras.
const WIN_ANSI: Record<string, number> = {
  '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99,
};

function encodeChar(ch: string): number {
  const code = ch.codePointAt(0)!;
  if (WIN_ANSI[ch] !== undefined) return WIN_ANSI[ch];
  if ((code >= 32 && code <= 126) || (code >= 0xa0 && code <= 0xff)) return code;
  return 0x3f; // "?"
}

export function textWidth(s: string, font: Font, size: number): number {
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    w += code >= 32 && code <= 126 ? WIDTHS[font][code - 32] : 556;
  }
  return (w * size) / 1000;
}

// Splits text into lines no wider than `max`, breaking at spaces (or
// mid-word when one word is too long).
export function wrap(s: string, font: Font, size: number, max: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of s.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (textWidth(next, font, size) <= max) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    while (textWidth(line, font, size) > max && line.length > 1) {
      let cut = line.length - 1;
      while (cut > 1 && textWidth(line.slice(0, cut), font, size) > max) cut--;
      lines.push(line.slice(0, cut));
      line = line.slice(cut);
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

const num = (n: number) => (Math.round(n * 100) / 100).toString();
const rgb = (c: Rgb) => c.map((v) => num(v / 255)).join(' ');
const hex = (s: string) => Array.from(s, (ch) => encodeChar(ch).toString(16).padStart(2, '0')).join('');

export class PdfPage {
  ops: string[] = [];
  constructor(readonly width: number, readonly height: number) {}

  text(x: number, y: number, s: string, opts: { font?: Font; size?: number; color?: Rgb; align?: 'left' | 'center' | 'right'; spacing?: number } = {}) {
    const font = opts.font ?? 'R';
    const size = opts.size ?? 10;
    const spacing = opts.spacing ?? 0;
    const w = textWidth(s, font, size) + spacing * Math.max(0, [...s].length - 1);
    const left = opts.align === 'center' ? x - w / 2 : opts.align === 'right' ? x - w : x;
    // `y` is the baseline. Tc (letter spacing) is page state, so it is set
    // on every run.
    this.ops.push(`BT /${font === 'B' ? 'F2' : 'F1'} ${num(size)} Tf ${num(spacing)} Tc ${rgb(opts.color ?? [0, 0, 0])} rg ${num(left)} ${num(this.height - y)} Td <${hex(s)}> Tj ET`);
  }

  line(x1: number, y1: number, x2: number, y2: number, color: Rgb, width = 1) {
    this.ops.push(`${rgb(color)} RG ${num(width)} w ${num(x1)} ${num(this.height - y1)} m ${num(x2)} ${num(this.height - y2)} l S`);
  }

  rect(x: number, y: number, w: number, h: number, opts: { fill?: Rgb; stroke?: Rgb; lineWidth?: number; radius?: number }) {
    const r = Math.min(opts.radius ?? 0, w / 2, h / 2);
    const top = this.height - y;
    let path: string;
    if (r > 0) {
      const k = r * 0.5523;
      const [l, rt, t, b] = [x, x + w, top, top - h];
      path = `${num(l + r)} ${num(t)} m ${num(rt - r)} ${num(t)} l ${num(rt - r + k)} ${num(t)} ${num(rt)} ${num(t - r + k)} ${num(rt)} ${num(t - r)} c ` +
        `${num(rt)} ${num(b + r)} l ${num(rt)} ${num(b + r - k)} ${num(rt - r + k)} ${num(b)} ${num(rt - r)} ${num(b)} c ` +
        `${num(l + r)} ${num(b)} l ${num(l + r - k)} ${num(b)} ${num(l)} ${num(b + r - k)} ${num(l)} ${num(b + r)} c ` +
        `${num(l)} ${num(t - r)} l ${num(l)} ${num(t - r + k)} ${num(l + r - k)} ${num(t)} ${num(l + r)} ${num(t)} c h`;
    } else {
      path = `${num(x)} ${num(top - h)} ${num(w)} ${num(h)} re`;
    }
    this.paint(path, opts);
  }

  circle(cx: number, cy: number, r: number, opts: { fill?: Rgb; stroke?: Rgb; lineWidth?: number }) {
    const y = this.height - cy;
    const k = r * 0.5523;
    const path = `${num(cx + r)} ${num(y)} m ` +
      `${num(cx + r)} ${num(y + k)} ${num(cx + k)} ${num(y + r)} ${num(cx)} ${num(y + r)} c ` +
      `${num(cx - k)} ${num(y + r)} ${num(cx - r)} ${num(y + k)} ${num(cx - r)} ${num(y)} c ` +
      `${num(cx - r)} ${num(y - k)} ${num(cx - k)} ${num(y - r)} ${num(cx)} ${num(y - r)} c ` +
      `${num(cx + k)} ${num(y - r)} ${num(cx + r)} ${num(y - k)} ${num(cx + r)} ${num(y)} c h`;
    this.paint(path, opts);
  }

  // A checkmark drawn as a stroked path (the standard fonts have none).
  check(cx: number, cy: number, size: number, color: Rgb, width: number) {
    const y = this.height - cy;
    this.ops.push(`q 1 J 1 j ${rgb(color)} RG ${num(width)} w ${num(cx - size * 0.5)} ${num(y)} m ${num(cx - size * 0.15)} ${num(y - size * 0.38)} l ${num(cx + size * 0.55)} ${num(y + size * 0.42)} l S Q`);
  }

  private paint(path: string, opts: { fill?: Rgb; stroke?: Rgb; lineWidth?: number }) {
    const parts = [];
    if (opts.fill) parts.push(`${rgb(opts.fill)} rg`);
    if (opts.stroke) parts.push(`${rgb(opts.stroke)} RG ${num(opts.lineWidth ?? 1)} w`);
    parts.push(path, opts.fill && opts.stroke ? 'B' : opts.fill ? 'f' : 'S');
    this.ops.push(parts.join(' '));
  }
}

interface Attachment {
  name: string;
  mime: string;
  description: string;
  data: Uint8Array;
}

export class PdfDocument {
  pages: PdfPage[] = [];
  private attachments: Attachment[] = [];

  constructor(private info: { title: string; author?: string; subject?: string; created: Date }, readonly width = 612, readonly height = 792) {}

  addPage(): PdfPage {
    const page = new PdfPage(this.width, this.height);
    this.pages.push(page);
    return page;
  }

  // Files carried inside the PDF (shown in a reader's attachments panel).
  attach(file: Attachment) {
    this.attachments.push(file);
  }

  toBytes(): Uint8Array {
    const enc = new TextEncoder();
    const chunks: Uint8Array[] = [];
    const offsets: number[] = [];
    let length = 0;
    const push = (b: Uint8Array) => {
      chunks.push(b);
      length += b.length;
    };
    const objects: Array<string | { dict: string; data: Uint8Array }> = [];
    const add = (o: string | { dict: string; data: Uint8Array }) => objects.push(o);
    const literal = (s: string) => `<${hex(s)}>`;
    // UTF-16BE with byte-order mark, for names and metadata outside WinAnsi.
    const unicode = (s: string) => `<FEFF${Array.from(s, (ch) => {
      const cp = ch.codePointAt(0)!;
      if (cp < 0x10000) return cp.toString(16).padStart(4, '0');
      const v = cp - 0x10000;
      return ((v >> 10) + 0xd800).toString(16) + ((v & 0x3ff) + 0xdc00).toString(16);
    }).join('')}>`;
    const date = (d: Date) => `(D:${d.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z)`;

    const catalog = add('');
    const pagesObj = add('');
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const pageRefs: number[] = [];
    for (const page of this.pages) {
      const content = add({ dict: '', data: enc.encode(page.ops.join('\n')) });
      pageRefs.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${this.width} ${this.height}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
    }
    objects[pagesObj - 1] = `<< /Type /Pages /Kids [${pageRefs.map((r) => `${r} 0 R`).join(' ')}] /Count ${pageRefs.length} >>`;
    const files: string[] = [];
    for (const a of this.attachments) {
      const stream = add({ dict: `/Type /EmbeddedFile /Subtype /${a.mime.replace('/', '#2F')} /Params << /Size ${a.data.length} /ModDate ${date(this.info.created)} >>`, data: a.data });
      const spec = add(`<< /Type /Filespec /F ${literal(a.name)} /UF ${unicode(a.name)} /Desc ${unicode(a.description)} /AFRelationship /Data /EF << /F ${stream} 0 R /UF ${stream} 0 R >> >>`);
      files.push(`${literal(a.name)} ${spec} 0 R`);
    }
    const names = files.length ? ` /Names << /EmbeddedFiles << /Names [${files.join(' ')}] >> >> /AF [${files.map((f) => f.split(' ').slice(1).join(' ')).join(' ')}]` : '';
    objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R${names} >>`;
    const info = add(`<< /Title ${unicode(this.info.title)}${this.info.author ? ` /Author ${unicode(this.info.author)}` : ''}${this.info.subject ? ` /Subject ${unicode(this.info.subject)}` : ''} /Producer (Aurelius Code) /CreationDate ${date(this.info.created)} >>`);

    push(enc.encode('%PDF-1.7\n'));
    push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // marks the file as binary
    objects.forEach((o, i) => {
      offsets.push(length);
      if (typeof o === 'string') {
        push(enc.encode(`${i + 1} 0 obj\n${o}\nendobj\n`));
      } else {
        push(enc.encode(`${i + 1} 0 obj\n<< ${o.dict} /Length ${o.data.length} >>\nstream\n`));
        push(o.data);
        push(enc.encode('\nendstream\nendobj\n'));
      }
    });
    const xref = length;
    push(enc.encode(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`));
    push(enc.encode(`trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`));

    const out = new Uint8Array(length);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

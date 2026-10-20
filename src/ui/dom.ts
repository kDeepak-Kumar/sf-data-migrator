// Tiny DOM helpers. All text goes through textContent, so record data can never inject markup.

type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, unknown> & { class?: string; style?: string };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'class') el.className = String(v);
      else if (k === 'style') el.setAttribute('style', String(v));
      else if (k === 'value') (el as unknown as HTMLInputElement).value = String(v);
      else if (k === 'checked') (el as unknown as HTMLInputElement).checked = !!v;
      else if (k === 'disabled') (el as unknown as HTMLButtonElement).disabled = !!v;
      else if (k === 'selected') (el as unknown as HTMLOptionElement).selected = !!v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el: Element) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function download(name: string, data: BlobPart, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = h('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function fmt(n: number): string {
  return n.toLocaleString();
}

export function stamp(): string {
  const d = new Date();
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function readFile(file: File): Promise<Uint8Array> {
  return file.arrayBuffer().then((b) => new Uint8Array(b));
}

export function select(value: string, options: [string, string][], onchange: (v: string) => void, attrs: Attrs = {}) {
  return h(
    'select',
    { ...attrs, onchange: (e: Event) => onchange((e.target as HTMLSelectElement).value) },
    options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)),
  );
}

// public/game/MemoryCard.ts
// Pure-DOM component. Renders one memory trace entry.
// No Phaser dependency; used inside #pane-interview.

/**
 * Kind icons for the three memory types.
 */
const KIND_ICON: Record<string, string> = {
  observation: '👁',
  chat:        '💬',
  thought:     '💡',
};

export interface MemoryEntry {
  memoryId: number | string;
  text: string;
  kind: 'observation' | 'chat' | 'thought';
  recency: number;     // 0-1 normalised
  relevance: number;   // 0-1 normalised (raw cosine for display)
  importance: number;  // 0-1 normalised
  score: number;       // final weighted score
  aboveThreshold: boolean;
  simTime: number;     // epoch ms
  sourceRef: string | null;
  evidenceIds: number[] | null;
}

/**
 * Build and return a `.memory-card` DOM element.
 * Does NOT append to DOM — caller decides placement.
 *
 * @param mem        The memory trace entry to display.
 * @param isTopSet   true → gold highlight (above threshold AND cited)
 * @param onEvidenceClick  callback when an evidence link is clicked
 * @returns HTMLElement  .memory-card ready to append
 */
export function buildMemoryCard(
  mem: MemoryEntry,
  isTopSet: boolean,
  onEvidenceClick: (id: number) => void,
): HTMLElement {
  const card = document.createElement('div');
  card.className = 'memory-card' + (isTopSet ? ' top-set' : '');
  card.dataset['memoryId'] = String(mem.memoryId);

  // Header: kind icon + timestamp
  const header = document.createElement('div');
  header.className = 'memory-card-header';

  const icon = document.createElement('span');
  icon.className = 'memory-kind-icon';
  icon.textContent = KIND_ICON[mem.kind] ?? '•';
  icon.title = mem.kind;

  const ts = document.createElement('span');
  ts.style.cssText = 'font-size:10px;color:var(--text-dim);font-family:var(--mono);';
  ts.textContent = _fmtTs(mem.simTime);

  if (isTopSet) {
    const star = document.createElement('span');
    star.style.cssText = 'margin-left:auto;color:var(--gold);font-size:12px;';
    star.textContent = '★';
    header.append(icon, ts, star);
  } else {
    header.append(icon, ts);
  }

  // Text
  const textEl = document.createElement('div');
  textEl.className = 'memory-text';
  textEl.textContent = mem.text;

  // Bars: clamp all values to [0,1] before display
  const bars = document.createElement('div');
  bars.className = 'memory-bars';
  bars.append(
    _bar('Recency',    mem.recency,    'bar-rec'),
    _bar('Relevance',  mem.relevance,  'bar-rel'),
    _bar('Importance', mem.importance, 'bar-imp'),
  );

  // Score formula
  const score = document.createElement('div');
  score.className = 'memory-score';
  score.textContent = `score = 0.5·rec + 3.0·rel + 2.0·imp = ${mem.score.toFixed(3)}`;

  card.append(header, textEl, bars, score);

  // Evidence pointers (for thought-kind reflections)
  if (mem.kind === 'thought' && Array.isArray(mem.evidenceIds) && mem.evidenceIds.length > 0) {
    const ev = document.createElement('div');
    ev.className = 'memory-evidence';
    ev.textContent = 'based on memories ';
    for (const eid of mem.evidenceIds) {
      const lnk = document.createElement('span');
      lnk.className = 'ev-link';
      lnk.textContent = `#${eid}`;
      lnk.addEventListener('click', () => onEvidenceClick(eid));
      ev.appendChild(lnk);
      ev.appendChild(document.createTextNode(' '));
    }
    card.appendChild(ev);
  }

  // Source ref
  if (mem.sourceRef) {
    const ref = document.createElement('div');
    ref.style.cssText = 'font-size:10px;color:var(--accent);margin-top:3px;';
    ref.textContent = mem.sourceRef;
    card.appendChild(ref);
  }

  return card;
}

/**
 * Animate all bar fills inside a card to their target widths.
 * Call after appending the card to DOM (needs a paint tick to start transition).
 * @param card  The .memory-card element
 */
export function animateBars(card: HTMLElement): void {
  const fills = card.querySelectorAll<HTMLElement>('.memory-bar-fill');
  // rAF so transition starts after paint
  requestAnimationFrame(() => {
    for (const fill of fills) {
      fill.style.width = (fill.dataset['target'] ?? '0') + '%';
    }
  });
}

/* ────────────────────────────── helpers ─── */

function _bar(label: string, value: number, colorClass: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'memory-bar-row';

  const lbl = document.createElement('span');
  lbl.className = 'memory-bar-label';
  lbl.textContent = label;

  const track = document.createElement('div');
  track.className = 'memory-bar-track';

  const fill = document.createElement('div');
  fill.className = `memory-bar-fill ${colorClass}`;
  fill.style.width = '0%'; // animated by animateBars() via requestAnimationFrame

  // Clamp value to [0,1] and store as 0-100 integer
  fill.dataset['target'] = String(Math.round(Math.max(0, Math.min(1, value)) * 100));

  track.appendChild(fill);
  row.append(lbl, track);
  return row;
}

function _fmtTs(epochMs: number): string {
  if (!epochMs) return '';
  const d = new Date(epochMs);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `${days[d.getUTCDay()]} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

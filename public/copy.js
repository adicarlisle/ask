// Click-to-copy commands: the whole line is the button; the icon shows on hover or focus.
// Without JavaScript nothing here runs, and one click still selects the whole command (CSS).
'use strict';
for (const block of document.querySelectorAll('.copy')) {
  const code = block.querySelector('code');
  const status = block.querySelector('.copy-status');
  const word = block.querySelector('.copy-word');
  if (!code || !navigator.clipboard) continue;
  block.classList.add('js');
  block.tabIndex = 0;
  block.setAttribute('role', 'button');
  block.setAttribute('aria-label', block.dataset.label || 'Copy command');
  let timer;
  const copy = async () => {
    // If they've dragged to select part of the command, leave the selection alone.
    const sel = getSelection();
    if (!sel.isCollapsed && block.contains(sel.anchorNode) && sel.toString() !== code.textContent) return;
    try {
      await navigator.clipboard.writeText(code.textContent);
      block.classList.add('done');
      word.textContent = 'Copied';
      status.textContent = 'Copied';
    } catch {
      getSelection().selectAllChildren(code);
      word.textContent = 'Press Ctrl+C';
    }
    clearTimeout(timer);
    timer = setTimeout(() => { block.classList.remove('done'); word.textContent = 'Copy'; status.textContent = ''; }, 1800);
  };
  block.addEventListener('click', copy);
  block.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copy(); } });
}

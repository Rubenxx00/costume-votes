/**
 * Tap-to-enlarge for costume photos.
 *
 * Grids always render the small preview. The HD file is attached as `data-hd`
 * and only fetched when the image is actually clicked, so nobody pays for 50
 * full-size photos just to look at a ballot.
 *
 * Usage:  <img src="preview.jpg" data-hd="hd.jpg">
 * Any element with class `zoomable` works; the HD source is inherited from
 * itself or an ancestor with data-hd.
 */
(() => {
  let overlay = null;
  let lastFocus = null;

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.className = 'lightbox';
    overlay.hidden = true;
    overlay.innerHTML = `
      <button class="lightbox-close" type="button" aria-label="Chiudi">&times;</button>
      <figure>
        <img alt="">
        <figcaption></figcaption>
      </figure>`;
    overlay.addEventListener('click', (e) => {
      // Click anywhere outside the image itself to dismiss.
      if (e.target === overlay || e.target.closest('.lightbox-close')) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !overlay.hidden) close();
    });
    document.body.appendChild(overlay);
    return overlay;
  }

  function open(src, caption) {
    const box = ensureOverlay();
    lastFocus = document.activeElement;
    const img = box.querySelector('img');
    // The HD request starts here, not at page load.
    img.src = src;
    box.querySelector('figcaption').textContent = caption || '';
    box.hidden = false;
    document.body.classList.add('lightbox-open');
    box.querySelector('.lightbox-close').focus();
  }

  function close() {
    if (!overlay || overlay.hidden) return;
    overlay.hidden = true;
    overlay.querySelector('img').removeAttribute('src'); // free the memory
    document.body.classList.remove('lightbox-open');
    lastFocus?.focus?.();
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('.zoomable');
    if (!el) return;
    const hd = el.dataset.hd;
    if (!hd) return;
    e.preventDefault();
    open(hd, el.dataset.caption || '');
  });

  // Middle-click / ctrl-click should still open the raw file in a new tab.
  document.addEventListener('auxclick', (e) => {
    const el = e.target.closest('.zoomable');
    if (!el || !el.dataset.hd) return;
    window.open(el.dataset.hd, '_blank', 'noopener');
  });

  window.costumeLightbox = { open, close };
})();
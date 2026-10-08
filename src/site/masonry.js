const grid = document.querySelector('.gallery');
const cards = [...document.querySelectorAll('.card')];
if (grid && cards.length) {
  let scheduled = false;
  const layout = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      const style = getComputedStyle(grid);
      const gap = Number.parseFloat(style.rowGap);
      const row = 8;
      for (const card of cards) {
        const height = card.querySelector('.card-inner').getBoundingClientRect().height;
        card.style.gridRowEnd = `span ${Math.ceil((height + gap) / (row + gap))}`;
      }
      grid.classList.add('masonry');
      scheduled = false;
    });
  };
  const observer = new ResizeObserver(layout);
  cards.forEach((card) => observer.observe(card.querySelector('.card-inner')));
  grid.querySelectorAll('img').forEach((image) => image.addEventListener('load', layout));
  window.addEventListener('resize', layout);
  document.fonts.ready.then(layout);
  layout();
}

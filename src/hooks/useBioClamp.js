import { useLayoutEffect } from 'react';

function measure(bios) {
  const overflowing = bios.map((bio) => bio.scrollHeight > bio.clientHeight + 1);
  bios.forEach((bio, i) => {
    bio.closest('.tutor-card').toggleAttribute('data-has-more', overflowing[i]);
  });
}

function onFirstScreen(bios) {
  const result = [];
  for (const bio of bios) {
    const rect = bio.getBoundingClientRect();
    if (rect.top >= window.innerHeight) break;
    if (rect.bottom > 0) result.push(bio);
  }
  return result;
}

export function useBioClamp(containerRef, deps) {
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || typeof IntersectionObserver === 'undefined') return undefined;

    const bios = [...container.querySelectorAll('.tutor-card__bio')];
    measure(onFirstScreen(bios));

    const nearViewport = new Set();
    const observer = new IntersectionObserver(
      (entries) => {
        const entered = [];
        for (const entry of entries) {
          if (entry.isIntersecting) {
            nearViewport.add(entry.target);
            entered.push(entry.target);
          } else {
            nearViewport.delete(entry.target);
          }
        }
        measure(entered);
      },
      { rootMargin: '100% 0px' }
    );
    bios.forEach((bio) => observer.observe(bio));

    let frame = 0;
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => measure([...nearViewport]));
    };
    window.addEventListener('resize', onResize);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
    };
  }, deps);
}

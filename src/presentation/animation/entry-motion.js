/** Retain the existing camera path and endpoints; bound only entry duration. */
export default function limitEntryMotion(tween, seconds, browser = window) {
  const budget = browser.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0.016 : seconds;
  tween.timeScale = Math.max(1, tween.totalLifeTime / budget);
}

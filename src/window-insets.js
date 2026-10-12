export function windowInsets(bounds, width, height, previousHorizontal = 0) {
  const rawHorizontal = Math.max(0, bounds.width - width);
  // Chrome has a minimum native window width. The extra content space is not
  // a border; treating it as one crops the page and leaks the address bar.
  const horizontal = rawHorizontal > 32 ? previousHorizontal : rawHorizontal;
  const vertical = Math.max(0, bounds.height - height);
  const left = Math.floor(horizontal / 2), right = horizontal - left, bottom = left;
  return { horizontal, vertical, left, right, top: Math.max(0, vertical - bottom), bottom };
}

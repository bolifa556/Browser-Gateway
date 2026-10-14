// A touchscreen does not make a mouse-driven laptop a touch-primary device.
// Keep touch input/keyboard support separate from the website's pointer mode.
export function inputCapabilities(environment = globalThis) {
  const touch = Number(environment.navigator?.maxTouchPoints) > 0;
  return { touch, touchPrimary: touch && environment.matchMedia('(pointer:coarse)').matches };
}

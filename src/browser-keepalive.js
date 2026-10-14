// A separate, minimized blank window keeps headed Chrome alive after the last
// member window expires. It has no PageSession, capture process or website.
export async function createBrowserKeepalive(browserCdp) {
  const { targetId } = await browserCdp.send('Target.createTarget', {
    url: 'about:blank', newWindow: true, background: true, width: 320, height: 240,
  });
  const { windowId } = await browserCdp.send('Browser.getWindowForTarget', { targetId });
  await browserCdp.send('Browser.setWindowBounds', {
    windowId, bounds: { windowState: 'minimized' },
  });
  return { targetId, windowId };
}

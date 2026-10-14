// Status-only, bounded diagnostics after a file handoff. Never inspect file
// contents, request bodies, full URLs, query strings, cookies or auth headers.
export function uploadRoute(request) {
  let url;try { url = new URL(request.url()); } catch { return null; }
  const host = url.hostname;
  if (host === 'chatgpt.com' && /^\/backend-api\/files(?:\/|$)/.test(url.pathname)) {
    return { host, stage: /upload.*complete|uploaded/.test(url.pathname) ? 'complete' : 'file-api', method: request.method() };
  }
  if (/(^|\.)oaiusercontent\.com$/.test(host) || host.endsWith('.blob.core.windows.net')) {
    return { host, stage: 'storage', method: request.method() };
  }
  return null;
}

export function startUploadDiagnostic(page, logger, session, { durationMs = 120000, limit = 48 } = {}) {
  const pending = new Map();let requests = 0, responses = 0, failures = 0, stopped = false;
  const route = request => uploadRoute(request);
  const request = value => {
    if (stopped || requests >= limit) return;const meta = route(value);if (!meta) return;
    requests++;pending.set(value, { ...meta, at: performance.now() });
  };
  const response = value => {
    if (stopped || responses >= limit) return;const request = value.request(), meta = route(request);if (!meta) return;
    responses++;logger.info('upload_response', { session, ...meta, status: value.status(),
      elapsedMs: pending.has(request) ? Math.round(performance.now() - pending.get(request).at) : undefined });
  };
  const finished = value => pending.delete(value);
  const failed = value => {
    if (stopped || failures >= limit) return;const meta = route(value);if (!meta) return;
    failures++;pending.delete(value);
    const code = String(value.failure()?.errorText || '').match(/net::ERR_[A-Z_]+/)?.[0] || 'unknown';
    logger.info('upload_request_failed', { session, ...meta, code });
  };
  const stop = () => {
    if (stopped) return;stopped = true;clearTimeout(timer);
    page.off('request', request);page.off('response', response);page.off('requestfinished', finished);page.off('requestfailed', failed);
    logger.info('upload_diagnostic_finished', { session, requests, responses, failures,
      pending: [...pending.values()].map(({ host, stage, method, at }) => ({ host, stage, method, elapsedMs: Math.round(performance.now() - at) })) });
    pending.clear();
  };
  page.on('request', request);page.on('response', response);page.on('requestfinished', finished);page.on('requestfailed', failed);
  const timer = setTimeout(stop, durationMs);timer.unref?.();return stop;
}

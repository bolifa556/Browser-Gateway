// Bounded, opt-in status diagnostics. Never logs request bodies, full URLs,
// cookie values, authorization headers, challenge tokens or console messages.
export function classifyVerificationRequest(request){
  let url;try{url=new URL(request.url());}catch{return null;}
  const challenge=url.hostname==='challenges.cloudflare.com'||url.hostname.endsWith('.challenges.cloudflare.com');
  const document=url.hostname==='chatgpt.com'&&request.resourceType()==='document';
  const platform=url.hostname==='chatgpt.com'&&url.pathname.startsWith('/cdn-cgi/challenge-platform/');
  if(!challenge&&!document&&!platform)return null;
  const stage=document?'document':url.pathname.includes('/flow/')?'flow':url.pathname.includes('/pat/')?'pat':url.pathname.includes('/orchestrate/')?'orchestrate':url.pathname.includes('/turnstile/')?'widget':'platform';
  return {host:url.hostname,stage,resource:request.resourceType(),method:request.method()};
}

export function startNetworkDiagnostic(context,logger,durationMs=120000){
  const summary={responses:0,failures:0,consoleCodes:0};let stopped=false;
  const response=async value=>{
    const route=classifyVerificationRequest(value.request());if(!route||stopped)return;
    try{
      const headers=await value.allHeaders();if(stopped)return;
      const date=Date.parse(headers.date);
      summary.responses++;
      logger.info('verification_response',{...route,status:value.status(),clockBehindSec:Number.isFinite(date)?Math.round((date-Date.now())/1000):undefined,mitigated:headers['cf-mitigated']==='challenge',cache:headers['cf-cache-status']});
    }catch{}
  };
  const failure=request=>{
    const route=classifyVerificationRequest(request);if(!route||stopped)return;
    summary.failures++;const code=String(request.failure()?.errorText||'').match(/net::ERR_[A-Z_]+/)?.[0]||'unknown';
    logger.info('verification_request_failed',{...route,code});
  };
  const consoleCode=message=>{
    const code=message.text().match(/(?:Turnstile(?:Error)?|error\s+code)[^\d]*([1-6]\d{5})/i)?.[1];
    if(!code||stopped)return;summary.consoleCodes++;logger.info('verification_console_code',{code});
  };
  context.on('response',response);context.on('requestfailed',failure);context.on('console',consoleCode);
  const stop=()=>{
    if(stopped)return;stopped=true;clearTimeout(timer);
    context.off('response',response);context.off('requestfailed',failure);context.off('console',consoleCode);
    logger.info('verification_diagnostic_finished',summary);
  };
  const timer=setTimeout(stop,durationMs);timer.unref();
  logger.info('verification_diagnostic_started',{durationSeconds:durationMs/1000});
  return stop;
}

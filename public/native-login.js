const start=document.querySelector('#start-login'),finish=document.querySelector('#finish-login'),error=document.querySelector('#start-error'),status=document.querySelector('#login-status');
let tab=sessionStorage.getItem('gptw_tab');if(!tab){tab=crypto.randomUUID?.()||`${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;sessionStorage.setItem('gptw_tab',tab);}
async function change(action,body={}){
  const response=await fetch(`/api/native-login/${action}`,{method:'POST',headers:{'Content-Type':'application/json','X-Gpt-Tab':tab},body:JSON.stringify(body)});
  const result=await response.json();if(!response.ok)throw Error(result.error||'模式切换失败');return result;
}
start.addEventListener('click',async()=>{
  start.disabled=true;error.hidden=true;start.textContent='正在切换浏览器，请稍等…';
  try{
    const stage=document.querySelector('#stage');
    await change('start',{confirm:true,viewport:{width:stage.clientWidth,height:stage.clientHeight,deviceScaleFactor:devicePixelRatio||1}});
    finish.hidden=false;status.textContent='请人工完成 ChatGPT / Google 登录，然后恢复成员页面';
    document.querySelector('#connection').textContent='正在连接手动登录窗口…';
    await import('./app.js?v=1.4.0');
  }catch(e){error.textContent=e.message;error.hidden=false;start.disabled=false;start.textContent='开始手动登录';}
});
finish.addEventListener('click',async()=>{
  finish.disabled=true;status.textContent='正在保存浏览器数据并恢复成员页面…';
  try{await change('finish');location.replace('/');}catch(e){status.textContent=e.message;finish.disabled=false;}
});

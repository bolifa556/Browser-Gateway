const form=document.querySelector('form');
if(location.pathname==='/admin/signin'){
  const target=document.createElement('input');target.type='hidden';target.name='returnTo';target.value='/admin/signin';form.append(target);
}
if(new URLSearchParams(location.search).has('error'))document.querySelector('#login-error').hidden=false;

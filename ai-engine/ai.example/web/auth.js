'use strict';
let loginToken=null,setupRequired=false;
function showLogin(setup=false){
 if(typeof resetAssistant==='function')resetAssistant();
 profileCustomerId=null;profilePayload=null;profileRequest++;$('customer-profile').replaceChildren();
 // Clear the password only when returning from a session, not while someone types during first load.
 const signedOut=$('auth-panel').hidden;
 setupRequired=setup;document.body.classList.add('auth-required');$('auth-panel').hidden=false;
 for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();
 $('auth-name-label').hidden=!setup;$('auth-name').required=setup;
 $('auth-title').textContent=setup?'Create your administrator':'Welcome back';
 $('auth-description').textContent=setup?'Set up the owner account for this CRM. You can add your team and assign roles after signing in.':'Sign in to your ISP workspace to continue.';
 $('auth-submit').textContent=setup?'Create administrator':'Sign in';
 $('auth-password').minLength=setup?10:1;$('auth-password').autocomplete=setup?'new-password':'current-password';
 if(signedOut)$('auth-password').value='';$('auth-password').type='password';$('auth-password-toggle').textContent='Show';$('auth-password-toggle').setAttribute('aria-label','Show password');$('auth-password-toggle').setAttribute('aria-pressed','false');$('auth-caps-lock').hidden=true;$('auth-error').textContent='';
}
async function fetchAuthStatus(){const response=await fetch('/api/auth/status');const result=await response.json();if(!response.ok)throw Error(result.error);loginToken=result.token;return result;}
async function startAuth(){
 try{const result=await fetchAuthStatus();
  if(result.user){document.body.classList.remove('auth-required');$('auth-panel').hidden=true;await load();}
  else{state=null;showLogin(result.setup_required);}
 }catch(error){showLogin(false);$('auth-error').textContent=error.message;}
}
function setAuthLoading(loading){
 const button=$('auth-submit');button.classList.toggle('is-loading',loading);
 if(loading)button.setAttribute('aria-busy','true');else button.removeAttribute('aria-busy');
 button.textContent=loading?(setupRequired?'Creating administrator…':'Signing in…'):(setupRequired?'Create administrator':'Sign in');
}
async function authRequest(path,fields,token){
 const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-CRM-Token':token},body:JSON.stringify(fields)});const result=await response.json();if(!response.ok)throw Error(result.error||'Request failed.');return result;
}
function updateAccountHeader(){
 const assistantLaunch=$('assistant-launch');if(assistantLaunch)assistantLaunch.disabled=false;
 $('account-name').textContent=state.user.name;$('account-role').textContent=state.user.role;
 $('account-avatar').textContent=state.user.name.split(' ').slice(0,2).map(n=>n[0]).join('');
 $('account-avatar').setAttribute('aria-label',state.user.name+' · '+state.user.designation);
}
function setupAuthControls(){
 setupRecoveryControls();
 $('auth-password-toggle').onclick=()=>{const input=$('auth-password'),visible=input.type==='password';input.type=visible?'text':'password';$('auth-password-toggle').textContent=visible?'Hide':'Show';$('auth-password-toggle').setAttribute('aria-label',visible?'Hide password':'Show password');$('auth-password-toggle').setAttribute('aria-pressed',String(visible));};
 const caps=event=>{$('auth-caps-lock').hidden=!event.getModifierState?.('CapsLock');};$('auth-password').addEventListener('keydown',caps);$('auth-password').addEventListener('keyup',caps);$('auth-password').addEventListener('blur',()=>{$('auth-caps-lock').hidden=true;});
 $('auth-form').onsubmit=async event=>{event.preventDefault();if($('auth-submit').classList.contains('is-loading'))return;setAuthLoading(true);$('auth-error').textContent='';try{if(!loginToken)await fetchAuthStatus();await authRequest(setupRequired?'/api/auth/setup':'/api/auth/login',{name:$('auth-name').value,username:$('auth-username').value,password:$('auth-password').value},loginToken);await startAuth();}catch(error){$('auth-error').textContent=error.message;}finally{setAuthLoading(false);}};
 $('logout').onclick=async()=>{try{await authRequest('/api/auth/logout',{},state.token);state=null;await startAuth();}catch(error){showError(error);}};
 $('change-password').onclick=()=>{$('password-form').reset();$('password-error').textContent='';$('password-dialog').showModal();};
 $('password-cancel').onclick=()=>$('password-dialog').close();
 $('password-form').onsubmit=async event=>{event.preventDefault();if($('new-password').value!==$('confirm-password').value){$('password-error').textContent='The new passwords do not match.';return;}$('password-save').disabled=true;try{await authRequest('/api/auth/password',{current_password:$('current-password').value,new_password:$('new-password').value},state.token);$('password-dialog').close();state=null;await startAuth();$('auth-error').textContent='Password changed. Sign in with your new password.';}catch(error){$('password-error').textContent=error.message;}finally{$('password-save').disabled=false;}};
}
function can(action,section=current){return (state?.permissions?.[action]??[]).includes(section);}
function canCreate(section=current){return can('write',section)&&!(state.user.role==='Technician'&&['Jobs','Tickets'].includes(section));}
function setupUserEditor(row){
 $('form-title').textContent=row?'Edit user account':'Create user account';const fields=$('form').elements;
 if(!row)fields.namedItem('role').value='Viewer';
 const wrapper=el('label',row?'New password (leave blank to keep current password)':'Password','full-field');const password=el('input');password.type='password';password.name='password';password.autocomplete='new-password';password.minLength=10;password.maxLength=128;password.required=!row;wrapper.append(password);$('fields').append(wrapper);
 const preview=el('div',undefined,'user-role-preview full-field');$('fields').append(preview);
 const update=()=>{const role=fields.namedItem('role').value,config=state.roles[role];preview.replaceChildren(el('strong',role),el('p',config.description),el('small','Can edit: '+(config.write.join(', ')||'None — read-only access')));fields.namedItem('staff_id').required=role==='Technician';};
 fields.namedItem('role').onchange=update;update();
 const suggest=()=>{const designation=fields.namedItem('designation').value.toLowerCase();const role=/administrator|owner|director/.test(designation)?'Administrator':/manager/.test(designation)?'Manager':/account|finance|cashier/.test(designation)?'Accountant':/technician|engineer/.test(designation)?'Technician':/store|inventory|warehouse/.test(designation)?'Storekeeper':/support|helpdesk|collector/.test(designation)?'Support':'Viewer';fields.namedItem('role').value=role;update();};
 fields.namedItem('designation').onchange=suggest;
 fields.namedItem('staff_id').onchange=()=>{const member=state.records.Staff.find(s=>String(s.id)===fields.namedItem('staff_id').value);if(member){fields.namedItem('name').value=member.name;fields.namedItem('designation').value=member.role;suggest();}};
 const note=el('p','Designation suggests a role; you can choose another role. Each employee can be linked to one login. Saving changes revokes that user’s active sessions. Deactivate an account to remove access.','expense-note full-field');$('fields').append(note);
}
function applyEditorPermissions(row){
 if(!can('write')){for(const input of $('fields').querySelectorAll('input,select,textarea'))input.disabled=true;$('save').hidden=true;}
 if(state.user.role==='Technician'&&row&&['Tickets','Jobs'].includes(current)){
  const editable=current==='Tickets'?['status','description','resolution_notes']:['status','notes'];
  for(const input of $('fields').querySelectorAll('input,select,textarea'))if(!editable.includes(input.name))input.disabled=true;
 }
}
function roleDashboard(){
 const panel=el('article',undefined,'dash-panel');panel.append(el('h2',`${state.user.name} · ${state.user.designation}`),el('p',state.permissions.description,'expense-note'));
 if(can('read','Payments')&&typeof buildFinancialDashboard==='function')panel.append(buildFinancialDashboard(state.records,today()));
 const cards=el('div',undefined,'role-module-grid');for(const section of Object.keys(state.schemas).filter(s=>!['Packages','Categories','Users','TAT settings'].includes(s))){const button=el('button',undefined,'role-module');button.append(navigationIcon(section),el('strong',section),el('span',`${state.records[section].length} records`),el('small',can('write',section)?'Manage records →':'View records →'));button.onclick=()=>navigate(section);cards.append(button);}panel.append(cards);
 if(state.user.role==='Technician')panel.append(el('p','Your tickets, jobs, and stock issues are filtered to your linked employee record.','expense-note'));
 $('dashboard').replaceChildren(panel);
}

function setupRecoveryControls(){
 const forgot=el('button','Forgot password?','text-button');forgot.type='button';forgot.id='forgot-password';$('auth-form').after(forgot);
 const dialog=el('dialog');dialog.id='recovery-dialog';const form=el('form'),heading=el('h2'),description=el('p',undefined,'expense-note'),emailLabel=el('label','Registered employee email'),email=el('input'),passwordLabel=el('label','New password'),password=el('input'),confirmLabel=el('label','Confirm new password'),confirm=el('input'),message=el('p',undefined,'expense-note'),actions=el('div',undefined,'form-actions'),cancel=el('button','Cancel','secondary'),submit=el('button','Send reset link');email.type='email';email.autocomplete='email';email.maxLength=254;email.id='recovery-email';emailLabel.append(email);password.type=confirm.type='password';password.autocomplete=confirm.autocomplete='new-password';password.minLength=confirm.minLength=10;password.maxLength=confirm.maxLength=128;password.id='recovery-password';confirm.id='recovery-confirm';passwordLabel.append(password);confirmLabel.append(confirm);message.setAttribute('role','status');cancel.type='button';submit.type='submit';actions.append(cancel,submit);form.append(heading,description,emailLabel,passwordLabel,confirmLabel,message,actions);dialog.append(form);document.body.append(dialog);
 let resetToken='';const open=token=>{resetToken=token;form.reset();message.textContent='';heading.textContent=token?'Set a new password':'Recover your password';description.textContent=token?'Use at least 10 characters. All existing sessions will be signed out.':'Enter the email registered on your employee record. Your login must be linked to that employee.';emailLabel.hidden=Boolean(token);email.required=!token;email.disabled=Boolean(token);passwordLabel.hidden=confirmLabel.hidden=!token;password.required=confirm.required=Boolean(token);password.disabled=confirm.disabled=!token;submit.textContent=token?'Reset password':'Send reset link';dialog.showModal();};forgot.onclick=()=>open('');cancel.onclick=()=>dialog.close();
 form.onsubmit=async event=>{event.preventDefault();if(resetToken&&password.value!==confirm.value){message.textContent='Passwords do not match.';return;}submit.disabled=true;try{if(!loginToken)throw Error('Wait for the sign-in page to finish loading, then try again.');const result=await authRequest(resetToken?'/api/auth/reset-password':'/api/auth/forgot-password',resetToken?{token:resetToken,password:password.value}:{email:email.value},loginToken);if(resetToken){dialog.close();await startAuth();$('auth-error').textContent=result.message;resetToken='';}else message.textContent=result.message;}catch(error){message.textContent=error.message;}finally{submit.disabled=false;}};
 const readResetLink=()=>{if(location.hash.startsWith('#reset=')){const token=location.hash.slice(7);history.replaceState(null,'',location.pathname+location.search);if(dialog.open)dialog.close();open(token);}};window.addEventListener('hashchange',readResetLink);readResetLink();
}

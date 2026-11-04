"""Employee-linked, single-use email password recovery."""
import hashlib,json,secrets,smtplib,ssl
from pathlib import Path
from email.message import EmailMessage
from urllib.parse import urlparse
import crm_auth as auth

CONFIG=Path(__file__).with_name('email.local.json')
MESSAGE='If an active login is linked to this registered employee email, a reset link will be sent. Check your inbox and spam folder.'
def initialize(db):
    db.execute('''CREATE TABLE IF NOT EXISTS password_resets(token_hash TEXT PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,email TEXT NOT NULL,expires_at TIMESTAMPTZ NOT NULL,used_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)''')
    db.execute('CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets(user_id)')
def settings():
    try:config=json.loads(CONFIG.read_text(encoding='utf-8'))
    except (OSError,ValueError):raise ValueError('Email recovery is not configured yet. Contact your administrator.')
    url=urlparse(config.get('base_url',''))
    if not config.get('host') or not config.get('from_email') or url.scheme!='https' or not url.netloc or url.username or url.query or url.fragment:
        raise ValueError('Email recovery settings need an SMTP server, sender and HTTPS CRM address.')
    return config

def send(config,address,token):
    message=EmailMessage();message['Subject']='Reset your ISP CRM password';message['From']=config['from_email'];message['To']=address
    link=config['base_url'].rstrip('/')+'/#reset='+token
    message.set_content('A password reset was requested for your ISP CRM login.\n\n'+link+'\n\nThis link expires in 20 minutes and can be used once. If you did not request this, ignore this email.\n')
    mode=config.get('security','starttls')
    if mode not in ('starttls','ssl'):raise ValueError('SMTP security must be starttls or ssl.')
    cls=smtplib.SMTP_SSL if mode=='ssl' else smtplib.SMTP
    with cls(config['host'],int(config.get('port',465 if mode=='ssl' else 587)),timeout=15,**({'context':ssl.create_default_context()} if mode=='ssl' else {})) as client:
        if mode=='starttls':client.starttls(context=ssl.create_default_context())
        if config.get('username'):client.login(config['username'],config.get('password',''))
        client.send_message(message)

def request(db,email,address):
    auth.check_attempts('recovery:'+address);auth.failed_attempt('recovery:'+address)
    config=settings();email=str(email).strip().lower()
    if len(email)>254 or not auth.re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+',email):raise ValueError('Enter a valid registered employee email.')
    users=list(db.execute("SELECT u.id,s.email FROM app_users u JOIN staff s ON s.id=u.staff_id WHERE lower(trim(s.email))=%s AND u.status='Active' FOR UPDATE OF u",(email,)))
    # Ambiguous shared employee emails never select an arbitrary account.
    if len(users)!=1:return MESSAGE
    user=users[0]
    recent=db.execute("SELECT 1 FROM password_resets WHERE user_id=%s AND created_at>CURRENT_TIMESTAMP-INTERVAL '2 minutes' LIMIT 1",(user['id'],)).fetchone()
    if recent:return MESSAGE
    token=secrets.token_urlsafe(32)
    db.execute('DELETE FROM password_resets WHERE user_id=%s OR expires_at<CURRENT_TIMESTAMP',(user['id'],))
    db.execute("INSERT INTO password_resets(token_hash,user_id,email,expires_at) VALUES (%s,%s,%s,CURRENT_TIMESTAMP+INTERVAL '20 minutes')",(hashlib.sha256(token.encode()).hexdigest(),user['id'],email))
    # Do not expose account existence or SMTP errors to the requester.
    try:send(config,user['email'],token)
    except (OSError,smtplib.SMTPException,ValueError):
        db.execute('DELETE FROM password_resets WHERE user_id=%s',(user['id'],))
    return MESSAGE

def reset(db,token,password,address):
    auth.check_attempts('reset:'+address);auth.failed_attempt('reset:'+address)
    if not isinstance(token,str) or len(token)>200:raise ValueError('Invalid or expired reset link. Request a new link.')
    digest=hashlib.sha256(token.encode()).hexdigest()
    # Lock user first to serialize with account administration and concurrent resets.
    row=db.execute('SELECT user_id FROM password_resets WHERE token_hash=%s',(digest,)).fetchone()
    if not row:raise ValueError('Invalid or expired reset link. Request a new link.')
    user=db.execute("SELECT u.id,s.email FROM app_users u JOIN staff s ON s.id=u.staff_id WHERE u.id=%s AND u.status='Active' FOR UPDATE OF u",(row['user_id'],)).fetchone()
    valid=db.execute('SELECT * FROM password_resets WHERE token_hash=%s AND used_at IS NULL AND expires_at>CURRENT_TIMESTAMP FOR UPDATE',(digest,)).fetchone()
    if not user or not valid or user['email'].strip().lower()!=valid['email']:raise ValueError('Invalid or expired reset link. Request a new link.')
    db.execute('UPDATE app_users SET password_hash=%s WHERE id=%s',(auth.hash_password(password),user['id']))
    db.execute('UPDATE password_resets SET used_at=CURRENT_TIMESTAMP WHERE user_id=%s',(user['id'],))
    db.execute('DELETE FROM app_sessions WHERE user_id=%s',(user['id'],))

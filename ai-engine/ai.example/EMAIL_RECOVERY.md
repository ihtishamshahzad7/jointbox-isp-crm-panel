Employee password recovery
==========================

1. Register the employee's personal work email in Staff. Each recovery email must identify one active linked login; shared addresses cannot recover accounts.
2. In Settings > User management, link the login to that employee. Existing administrators without an employee link must be linked before using recovery.
3. Copy email.example.json to email.local.json, then enter your SMTP provider's host, port, sender, username and application password locally. This file is excluded from version control. Use starttls (usually port 587) or ssl (usually 465).
4. Set base_url to the public HTTPS address of this CRM. Never use localhost for emails opened on other devices. Update it whenever a temporary demo tunnel address changes. Localhost and demo currently share this email configuration file; enable sending only with the intended public workspace address and employee data.
5. Choose Forgot password? on the login page. Enter the employee's registered email, open the emailed link, and set a password of 10–128 characters.

Links expire after 20 minutes, can be used once, and are stored only as hashes. Requests are limited and repeat emails are suppressed for two minutes. A reset revokes all existing sessions. Employee email changes invalidate outstanding links. Unknown, ambiguous and inactive accounts receive the same public response. No email is sent until SMTP is configured. Real email delivery requires a working provider and must be tested after configuration.

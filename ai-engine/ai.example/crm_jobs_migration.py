"""Idempotent migration of archived jobs to the unified ticket workflow."""

def migrate_jobs(db):
    db.execute('SELECT pg_advisory_xact_lock(73912403)')
    db.execute('ALTER TABLE tickets ADD COLUMN IF NOT EXISTS source_job_id BIGINT UNIQUE REFERENCES jobs(id) ON DELETE RESTRICT')
    jobs=list(db.execute('''SELECT j.* FROM jobs j WHERE NOT EXISTS
        (SELECT 1 FROM tickets t WHERE t.source_job_id=j.id) ORDER BY j.id FOR SHARE'''))
    for job in jobs:
        completed=job['status']=='Completed'
        ticket=db.execute('''INSERT INTO tickets(subject,customer_id,assigned_to,type,priority,status,due_date,description,resolution_notes,source_job_id,resolved_at)
            VALUES (%s,%s,%s,%s,'Normal',%s,%s,%s,%s,%s,CASE WHEN %s THEN CURRENT_TIMESTAMP ELSE NULL END)
            ON CONFLICT(source_job_id) DO NOTHING RETURNING id''',
            (job['title'],job['customer_id'],job['staff_id'],job['type'],'Resolved' if completed else job['status'],job['due_date'],
             f"Imported from job #{job['id']}.\n"+(job['notes'] or ''),'Completed in the previous Jobs module.' if completed else '',job['id'],completed)).fetchone()
        if ticket:
            db.execute('INSERT INTO ticket_events(ticket_id,message) VALUES (%s,%s)',(ticket['id'],f"Imported from job #{job['id']}; original employee, due date, notes and status retained."))
    return len(jobs)

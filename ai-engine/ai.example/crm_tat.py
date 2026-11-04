"""Continuous calendar-hour ticket turnaround targets."""
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

DEFAULT_HOURS={'Urgent':2,'High':4,'Normal':24,'Low':48}

def default_hours(db,ticket_type,priority):
    row=db.execute('SELECT hours FROM tat_settings WHERE ticket_type=%s AND priority=%s',(ticket_type,priority)).fetchone()
    return row['hours'] if row else DEFAULT_HOURS.get(priority,24)


def prepare_tat(db,rid,fields,user):
    previous=db.execute('SELECT * FROM tickets WHERE id=%s FOR UPDATE',(rid,)).fetchone() if rid else None
    raw=fields.get('tat_hours')
    if raw is None:
        hours=previous['tat_hours'] if previous else default_hours(db,fields.get('type'),fields.get('priority'))
    else:
        try:
            hours=int(str(raw))
        except (ValueError,TypeError):
            raise ValueError('TAT must be a whole number of hours.')
    if not 1<=hours<=720:
        raise ValueError('TAT must be between 1 and 720 hours.')
    if previous and user['role']=='Technician' and hours!=previous['tat_hours']:
        raise PermissionError('Contact a manager to change the ticket TAT.')
    start=previous['created_at'] if previous else datetime.now(ZoneInfo('Asia/Karachi'))
    if previous and hours==previous['tat_hours']:
        due=previous['due_at']
    elif raw is None:
        # Preserve date-based deadlines from older API clients.
        due=datetime.combine(datetime.fromisoformat(str(fields.get('due_date',''))).date(),time(23,59,59),ZoneInfo('Asia/Karachi'))
    else:
        due=start+timedelta(hours=hours)
        fields['due_date']=due.astimezone(ZoneInfo('Asia/Karachi')).date().isoformat()
    return hours,due,previous

"""Allocate stable employee codes inside the staff transaction."""

def initialize(db):
    db.execute('CREATE SEQUENCE IF NOT EXISTS employee_code_sequence')
    db.execute('''CREATE OR REPLACE FUNCTION assign_employee_code() RETURNS trigger AS $$
    DECLARE candidate TEXT; number BIGINT;
    BEGIN
        IF NEW.employee_code IS NULL OR trim(NEW.employee_code)='' THEN
            PERFORM pg_advisory_xact_lock(174392061);
            LOOP
                number := nextval('employee_code_sequence');
                candidate := 'EMP-' || lpad(number::text,greatest(6,length(number::text)),'0');
                EXIT WHEN NOT EXISTS (SELECT 1 FROM staff WHERE employee_code=candidate);
            END LOOP;
            NEW.employee_code := candidate;
        END IF;
        RETURN NEW;
    END;
    $$ LANGUAGE plpgsql''')
    db.execute('DROP TRIGGER IF EXISTS staff_employee_code ON staff')
    db.execute('CREATE TRIGGER staff_employee_code BEFORE INSERT OR UPDATE ON staff FOR EACH ROW EXECUTE FUNCTION assign_employee_code()')
    db.execute("UPDATE staff SET employee_code='' WHERE employee_code IS NULL OR trim(employee_code)=''")

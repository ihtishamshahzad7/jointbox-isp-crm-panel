"""Local ISP CRM. Run with: python ispcrm.py"""
import csv
import sqlite3
import tkinter as tk
from datetime import date
from pathlib import Path
from tkinter import filedialog, messagebox, ttk


DATABASE = Path(__file__).with_name('ispcrm.db')
SCHEMAS = {
    'Customers': [('Name', 'text'), ('Phone', 'text'), ('Address', 'text'),
                  ('Username', 'text'), ('Package', 'text'), ('Monthly fee', 'money'),
                  ('Status', ['Active', 'Suspended', 'Disconnected']), ('Joined', 'date')],
    'Inventory': [('Item', 'text'), ('Category', ['Router', 'ONU / ONT', 'Cable', 'Switch', 'Tools', 'Other']),
                  ('Quantity', 'integer'), ('Minimum stock', 'integer'), ('Unit cost', 'money'),
                  ('Location', 'text')],
    'Staff': [('Name', 'text'), ('Phone', 'text'),
              ('Role', ['Technician', 'Support', 'Collector', 'Manager', 'Other']),
              ('Area', 'text'), ('Status', ['Available', 'On duty', 'On leave'])],
    'Jobs': [('Title', 'text'), ('Customer ID', 'customer'), ('Staff ID', 'staff'),
             ('Type', ['Installation', 'Complaint', 'Maintenance', 'Collection']),
             ('Status', ['Open', 'In progress', 'Completed']), ('Due date', 'date'), ('Notes', 'text')],
    'Payments': [('Customer ID', 'customer'), ('Amount', 'money'), ('Payment date', 'date'),
                 ('Billing month', 'month'), ('Method', ['Cash', 'Bank transfer', 'Mobile wallet']),
                 ('Reference', 'text')],
}


def table_name(section):
    return section.lower()


def column_name(label):
    return label.lower().replace(' ', '_')


def connect_database(path=DATABASE):
    connection = sqlite3.connect(path)
    connection.execute('PRAGMA foreign_keys = ON')
    for section, fields in SCHEMAS.items():
        columns = ['id INTEGER PRIMARY KEY AUTOINCREMENT']
        for label, kind in fields:
            sql_type = 'INTEGER' if kind in ('integer', 'customer', 'staff') else 'REAL' if kind == 'money' else 'TEXT'
            definition = f'{column_name(label)} {sql_type} NOT NULL'
            if kind in ('customer', 'staff'):
                definition += f' REFERENCES {"customers" if kind == "customer" else "staff"}(id) ON DELETE RESTRICT'
            columns.append(definition)
        connection.execute(f'CREATE TABLE IF NOT EXISTS {table_name(section)} ({", ".join(columns)})')
    connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS unique_customer_username ON customers(username)")
    connection.commit()
    return connection


class CRM(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title('ISP CRM • Operations workspace')
        self.geometry('1220x760')
        self.minsize(940, 600)
        self.db = connect_database()
        self.protocol('WM_DELETE_WINDOW', self.close)
        style = ttk.Style(self)
        style.theme_use('clam')
        style.configure('Treeview', rowheight=30, font=('Segoe UI', 10))
        style.configure('Treeview.Heading', font=('Segoe UI', 10, 'bold'))
        style.configure('TButton', padding=8)
        style.configure('TLabel', font=('Segoe UI', 10))
        style.configure('Title.TLabel', font=('Segoe UI', 23, 'bold'))
        header = ttk.Frame(self, padding=20)
        header.pack(fill='x')
        ttk.Label(header, text='ISP CRM', style='Title.TLabel').pack(side='left')
        ttk.Label(header, text='Customers • Stock • Workforce', foreground='#526477').pack(side='left', padx=25)
        self.tabs = ttk.Notebook(self)
        self.tabs.pack(fill='both', expand=True, padx=20, pady=(0, 12))
        self.dashboard = ttk.Frame(self.tabs, padding=20)
        self.tabs.add(self.dashboard, text='  Dashboard  ')
        self.trees, self.searches = {}, {}
        for section in SCHEMAS:
            self.build_section(section)
        ttk.Label(self, text=f'Local database: {DATABASE}   |   Amounts in PKR', foreground='#526477').pack(anchor='w', padx=20, pady=(0, 10))
        self.refresh()

    def build_section(self, section):
        frame = ttk.Frame(self.tabs, padding=12)
        self.tabs.add(frame, text=f'  {section}  ')
        toolbar = ttk.Frame(frame)
        toolbar.pack(fill='x', pady=(0, 12))
        query = tk.StringVar()
        self.searches[section] = query
        ttk.Label(toolbar, text='Search').pack(side='left', padx=(0, 8))
        ttk.Entry(toolbar, textvariable=query, width=28).pack(side='left')
        query.trace_add('write', lambda *_args, s=section: self.refresh_table(s))
        for label, action in [('Add', lambda s=section: self.edit(s)),
                              ('Edit', lambda s=section: self.edit_selected(s)),
                              ('Delete', lambda s=section: self.delete(s)),
                              ('Export CSV', lambda s=section: self.export(s))]:
            ttk.Button(toolbar, text=label, command=action).pack(side='left', padx=(8, 0))
        grid = ttk.Frame(frame)
        grid.pack(fill='both', expand=True)
        columns = ['ID'] + [field[0] for field in SCHEMAS[section]]
        tree = ttk.Treeview(grid, columns=columns, show='headings', selectmode='browse')
        for column in columns:
            tree.heading(column, text=column)
            tree.column(column, width=125 if column != 'ID' else 55, minwidth=55)
        vertical = ttk.Scrollbar(grid, orient='vertical', command=tree.yview)
        horizontal = ttk.Scrollbar(grid, orient='horizontal', command=tree.xview)
        tree.configure(yscrollcommand=vertical.set, xscrollcommand=horizontal.set)
        tree.grid(row=0, column=0, sticky='nsew')
        vertical.grid(row=0, column=1, sticky='ns')
        horizontal.grid(row=1, column=0, sticky='ew')
        grid.rowconfigure(0, weight=1)
        grid.columnconfigure(0, weight=1)
        tree.bind('<Double-1>', lambda _event: self.edit_selected(section))
        self.trees[section] = tree

    def refresh_table(self, section):
        tree = self.trees[section]
        tree.delete(*tree.get_children())
        query = self.searches[section].get().casefold()
        for row in self.db.execute(f'SELECT * FROM {table_name(section)} ORDER BY id DESC'):
            if query in ' '.join(map(str, row)).casefold():
                tree.insert('', 'end', iid=str(row[0]), values=row)

    def refresh(self):
        for section in SCHEMAS:
            self.refresh_table(section)
        for widget in self.dashboard.winfo_children():
            widget.destroy()
        ttk.Label(self.dashboard, text='Operations overview', style='Title.TLabel').pack(anchor='w', pady=(0, 20))
        month = date.today().strftime('%Y-%m')
        metrics = [
            ('Active customers', "SELECT COUNT(*) FROM customers WHERE status='Active'", ()),
            ('Expected monthly fees (PKR)', "SELECT COALESCE(SUM(monthly_fee),0) FROM customers WHERE status='Active'", ()),
            ('Collected this month (PKR)', 'SELECT COALESCE(SUM(amount),0) FROM payments WHERE substr(payment_date,1,7)=?', (month,)),
            ('Open jobs', "SELECT COUNT(*) FROM jobs WHERE status!='Completed'", ()),
            ('Available staff', "SELECT COUNT(*) FROM staff WHERE status='Available'", ()),
            ('Low-stock items', 'SELECT COUNT(*) FROM inventory WHERE quantity<=minimum_stock', ()),
        ]
        for title, sql, params in metrics:
            value = self.db.execute(sql, params).fetchone()[0]
            row = ttk.Frame(self.dashboard, padding=10)
            row.pack(fill='x', pady=3)
            ttk.Label(row, text=title, width=38).pack(side='left')
            ttk.Label(row, text=f'{value:,.2f}' if 'PKR' in title else str(value), font=('Segoe UI', 16, 'bold')).pack(side='left')
        ttk.Label(self.dashboard, text='Start by adding customers and staff. Use their IDs to record payments and assign jobs.\nInventory quantities are maintained manually. Export any filtered list using Export CSV.', foreground='#526477').pack(anchor='w', pady=20)

    def selected(self, section):
        selection = self.trees[section].selection()
        if not selection:
            messagebox.showinfo('Select a record', 'Select a row first.', parent=self)
            return None
        return int(selection[0])

    def edit_selected(self, section):
        record_id = self.selected(section)
        if record_id is not None:
            self.edit(section, record_id)

    def edit(self, section, record_id=None):
        existing = self.db.execute(f'SELECT * FROM {table_name(section)} WHERE id=?', (record_id,)).fetchone() if record_id else None
        dialog = tk.Toplevel(self)
        dialog.title(f'{"Edit" if existing else "Add"} {section}')
        dialog.transient(self)
        dialog.grab_set()
        body = ttk.Frame(dialog, padding=20)
        body.pack(fill='both', expand=True)
        variables = []
        references = {}
        for index, (label, kind) in enumerate(SCHEMAS[section]):
            ttk.Label(body, text=label).grid(row=index, column=0, sticky='w', pady=6, padx=(0, 15))
            default = existing[index + 1] if existing else date.today().isoformat() if kind == 'date' else date.today().strftime('%Y-%m') if kind == 'month' else kind[0] if isinstance(kind, list) else '0' if kind in ('integer', 'money') else ''
            variable = tk.StringVar(value=default)
            variables.append(variable)
            if kind in ('customer', 'staff'):
                records = self.db.execute(f'SELECT id, name FROM {"customers" if kind == "customer" else "staff"} ORDER BY name').fetchall()
                choices = {f'{r[0]} — {r[1]}': r[0] for r in records}
                references[index] = choices
                variable.set(next((name for name, rid in choices.items() if str(rid) == str(default)), ''))
                widget = ttk.Combobox(body, textvariable=variable, values=list(choices), state='readonly', width=38)
            elif isinstance(kind, list):
                widget = ttk.Combobox(body, textvariable=variable, values=kind, state='readonly', width=38)
            else:
                widget = ttk.Entry(body, textvariable=variable, width=41)
            widget.grid(row=index, column=1, sticky='ew', pady=6)

        def save():
            try:
                values = []
                for index, ((label, kind), variable) in enumerate(zip(SCHEMAS[section], variables)):
                    value = variable.get().strip()
                    if not value and label not in ('Notes', 'Reference', 'Address', 'Location', 'Area'):
                        raise ValueError(f'{label} is required.')
                    if kind in ('integer', 'money'):
                        from decimal import Decimal, InvalidOperation
                        try:
                            number = Decimal(value)
                        except InvalidOperation:
                            raise ValueError(f'{label} must be a valid number.')
                        if not number.is_finite() or number < 0 or (kind == 'integer' and number != number.to_integral_value()):
                            raise ValueError(f'{label} must be a non-negative {"whole number" if kind == "integer" else "amount"}.')
                        value = int(number) if kind == 'integer' else round(float(number), 2)
                    elif kind == 'date':
                        if date.fromisoformat(value).isoformat() != value:
                            raise ValueError('Use dates in YYYY-MM-DD format.')
                    elif kind == 'month':
                        if date.fromisoformat(value + '-01').strftime('%Y-%m') != value:
                            raise ValueError('Use billing month in YYYY-MM format.')
                    elif index in references:
                        value = references[index][value]
                    values.append(value)
                columns = [column_name(label) for label, _kind in SCHEMAS[section]]
                with self.db:
                    if record_id:
                        assignments = ', '.join(f'{column}=?' for column in columns)
                        self.db.execute(f'UPDATE {table_name(section)} SET {assignments} WHERE id=?', values + [record_id])
                    else:
                        self.db.execute(f'INSERT INTO {table_name(section)} ({", ".join(columns)}) VALUES ({", ".join("?" for _ in values)})', values)
                dialog.destroy()
                self.refresh()
            except (ValueError, KeyError) as exc:
                messagebox.showerror('Check record', str(exc) or 'Select a valid linked record.', parent=dialog)
            except sqlite3.IntegrityError:
                messagebox.showerror('Cannot save', 'Username must be unique and linked customer or staff must exist.', parent=dialog)

        ttk.Label(body, text='Dates: YYYY-MM-DD · Billing month: YYYY-MM').grid(row=len(variables), columnspan=2, pady=10)
        ttk.Button(body, text='Save record', command=save).grid(row=len(variables) + 1, column=1, sticky='e')
        dialog.bind('<Escape>', lambda _event: dialog.destroy())

    def delete(self, section):
        record_id = self.selected(section)
        if record_id is None or not messagebox.askyesno('Delete record', f'Delete {section} record #{record_id}? This cannot be undone.', parent=self):
            return
        try:
            with self.db:
                self.db.execute(f'DELETE FROM {table_name(section)} WHERE id=?', (record_id,))
            self.refresh()
        except sqlite3.IntegrityError:
            messagebox.showerror('Record in use', 'This record has linked jobs or payments. Keep it to preserve those records.', parent=self)

    def export(self, section):
        path = filedialog.asksaveasfilename(parent=self, defaultextension='.csv', initialfile=f'{section.lower()}.csv', filetypes=[('CSV files', '*.csv')])
        if path:
            try:
                with open(path, 'w', newline='', encoding='utf-8-sig') as output:
                    writer = csv.writer(output)
                    writer.writerow(['ID'] + [label for label, _kind in SCHEMAS[section]])
                    for item in self.trees[section].get_children():
                        values = self.trees[section].item(item, 'values')
                        writer.writerow(["'" + str(v) if str(v).startswith(('=', '+', '-', '@', '\t', '\r')) else v for v in values])
                messagebox.showinfo('Export complete', 'CSV file saved.', parent=self)
            except OSError as exc:
                messagebox.showerror('Export failed', str(exc), parent=self)

    def close(self):
        self.db.close()
        self.destroy()


if __name__ == '__main__':
    CRM().mainloop()

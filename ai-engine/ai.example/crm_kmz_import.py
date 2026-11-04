"""Upload KMZ/KML: read pins and lines for review, then create POPs, network devices and fiber cables.

Step 1 (preview) only reads the file. Step 2 (import) saves the reviewed list through crm_operations.save,
so every record gets the usual checks, permanent ID and history. Nothing is deducted from stock.
"""
import io
import math
import re
import uuid
import zipfile
import xml.etree.ElementTree as ET
import crm_operations as ops

MAX_FILE = 15 * 1024 * 1024
MAX_KML = 60 * 1024 * 1024
MAX_ITEMS = 2000
MAX_ROUTE_POINTS = 1000
DEVICE_TYPES = next(f['options'] for f in ops.MODULES['Network devices']['fields'] if f['name'] == 'Type')
CABLE_TYPES = next(f['options'] for f in ops.MODULES['Fiber segments']['fields'] if f['name'] == 'Cable type')
CABLE_STATUSES = next(f['options'] for f in ops.MODULES['Fiber segments']['fields'] if f['name'] == 'Status')
# Checked in order against the name, folder and description; the first match wins.
GUESSES = [(r'\bpop\b', 'POP'), (r'\bdc\b|data ?cent', 'Data center (DC)'), (r'\bolt\b', 'OLT'), (r'\bfdt\b', 'FDT'),
           (r'\bfat\b', 'FAT'), (r'splitter|\bspl\b', 'Splitter'), (r'joint|closure|\bjc\b', 'Joint closure'),
           (r'dist(ribution)?\s*box|\bdb\b|\bbox\b', 'Distribution box'), (r'router|\brtr\b', 'Router'), (r'switch|\bsw\b', 'Switch')]


def local(tag):
    return tag.rsplit('}', 1)[-1]


def child_text(node, name):
    for child in node:
        if local(child.tag) == name:
            return (child.text or '').strip()
    return ''


def plain(text):
    return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', text or '')).strip()


def coordinates(text):
    points = []
    for token in (text or '').split():
        parts = token.split(',')
        try:
            lng, lat = float(parts[0]), float(parts[1])
        except (ValueError, IndexError):
            continue
        if math.isfinite(lat) and math.isfinite(lng) and -90 <= lat <= 90 and -180 <= lng <= 180:
            points.append((round(lat, 7), round(lng, 7)))
    return points


def metres(a, b):
    la, lb, dl = math.radians(a[0]), math.radians(b[0]), math.radians(b[1] - a[1])
    return 2 * 6371008.8 * math.asin(math.sqrt(math.sin((lb - la) / 2) ** 2 + math.cos(la) * math.cos(lb) * math.sin(dl / 2) ** 2))


def thin(points):
    if len(points) <= MAX_ROUTE_POINTS:
        return points, False
    step = (len(points) - 1) / (MAX_ROUTE_POINTS - 1)
    return [points[round(i * step)] for i in range(MAX_ROUTE_POINTS)], True


def guess_type(text):
    described = re.search(r'type:\s*([^\n<]+)', text, re.I)
    if described and described.group(1).strip() in DEVICE_TYPES:
        return described.group(1).strip()
    if re.search(r'customer|client|subscriber', text, re.I):
        return 'Skip'
    return next((kind for pattern, kind in GUESSES if re.search(pattern, text, re.I)), 'Other')


def read_kml(data):
    if len(data) > MAX_FILE:
        raise ValueError('Use a KMZ or KML file smaller than 15 MB.')
    if data[:2] == b'PK':
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                maps = [i for i in archive.infolist() if i.filename.lower().endswith('.kml')]
                if not maps:
                    raise ValueError('This KMZ has no KML map inside.')
                main = next((i for i in maps if i.filename.lower().rsplit('/', 1)[-1] == 'doc.kml'), maps[0])
                with archive.open(main) as handle:
                    data = handle.read(MAX_KML + 1)
        except zipfile.BadZipFile:
            raise ValueError('This KMZ file is damaged.')
        if len(data) > MAX_KML:
            raise ValueError('The map inside this KMZ is too large.')
    # KML never needs DTDs; refusing them blocks entity-expansion tricks.
    if b'<!DOCTYPE' in data or b'<!ENTITY' in data:
        raise ValueError('This map file contains unsupported XML declarations.')
    try:
        return ET.fromstring(data)
    except ET.ParseError:
        raise ValueError('This file is not a valid KMZ or KML map.')


def existing(db):
    rows = list(db.execute("SELECT module, data FROM operations_records WHERE module IN ('POPs','Network devices','Fiber segments') AND state!='Archived'"))
    points, lines = [], []
    for r in rows:
        d = r['data']; name = (d.get('name') or '').casefold()
        if r['module'] == 'Fiber segments':
            first = ops.route_points(d['route'])[0] if d.get('route') else None
            if first:
                lines.append((name, (float(first[0]), float(first[1]))))
        elif d.get('latitude') not in (None, ''):
            points.append((name, (float(d['latitude']), float(d['longitude']))))
    return points, lines


def preview(db, user, data):
    if not (ops.permitted(user, 'Fiber segments', True) or ops.permitted(user, 'Network devices', True)):
        raise PermissionError('Your role cannot add network map records.')
    root = read_kml(data)
    have_points, have_lines = existing(db)
    items, skipped = [], 0

    def placemark(node, folders):
        nonlocal skipped
        name = plain(child_text(node, 'name'))[:150] or 'Unnamed'
        description = plain(child_text(node, 'description'))
        folder = ' / '.join(folders)
        style = child_text(node, 'styleUrl').lower()
        geometries = [g for g in node.iter() if local(g.tag) in ('Point', 'LineString', 'Polygon', 'LinearRing')]
        lines = [g for g in geometries if local(g.tag) == 'LineString']
        for part, geometry in enumerate([g for g in geometries if local(g.tag) == 'Point'] + lines, 1):
            points = coordinates(child_text(geometry, 'coordinates'))
            label = name if part == 1 else f'{name} ({part})'
            if local(geometry.tag) == 'Point' and points:
                p = points[0]
                duplicate = any(n == label.casefold() and metres(p, q) < 15 for n, q in have_points)
                kind = 'Skip' if duplicate else guess_type(f'{name} {folder} {description}')
                items.append(dict(id=len(items), kind='point', name=label, folder=folder, description=description[:300],
                                  latitude=p[0], longitude=p[1], type=kind, duplicate=duplicate))
            elif local(geometry.tag) == 'LineString' and len(points) >= 2:
                route, simplified = thin(points)
                duplicate = any(n == label.casefold() and metres(route[0], q) < 15 for n, q in have_lines)
                text = f'{name} {folder} {description} {style}'
                status = next((s for s in CABLE_STATUSES if s.lower() in text.lower()), '')
                cable = next((c for c in CABLE_TYPES if c.lower() in text.lower()), '')
                cores = re.search(r'(\d{1,3})\s*(?:-|\s)?(?:core|cores|f\b|fibre|fiber)', text, re.I)
                items.append(dict(id=len(items), kind='line', name=label, folder=folder, description=description[:300], points=route,
                                  length_m=round(sum(metres(a, b) for a, b in zip(route, route[1:])), 1), simplified=simplified,
                                  type='Skip' if duplicate else 'Fiber cable', status=status, cable_type=cable,
                                  cores=int(cores.group(1)) if cores and int(cores.group(1)) > 0 else None, duplicate=duplicate))
            if len(items) > MAX_ITEMS:
                raise ValueError(f'This map has more than {MAX_ITEMS} pins and lines. Split it into smaller files.')
        if any(local(g.tag) == 'Polygon' for g in geometries):
            skipped += 1

    def walk(node, folders):
        for child in node:
            tag = local(child.tag)
            if tag in ('Document', 'Folder'):
                name = plain(child_text(child, 'name'))
                # Our own export names folders "POPs (3)"; drop the count.
                walk(child, folders + [re.sub(r'\s*\(\d+\)$', '', name)] if tag == 'Folder' and name else folders)
            elif tag == 'Placemark':
                placemark(child, folders)

    walk(root, [])
    if not items:
        raise ValueError('No pins or lines were found in this map.')
    return dict(items=items, polygons_skipped=skipped, device_types=DEVICE_TYPES, cable_types=CABLE_TYPES, statuses=CABLE_STATUSES)


def import_items(db, user, payload):
    items, zone = payload.get('items'), payload.get('zone')
    try:
        batch = uuid.UUID(str(payload.get('request_key')))
    except ValueError:
        raise ValueError('Reload the upload window and try again.')
    if not isinstance(items, list) or not 1 <= len(items) <= MAX_ITEMS:
        raise ValueError('Choose at least one pin or line to import.')
    made = dict(POPs=0, devices=0, cables=0)
    new_zone = str(payload.get('new_zone') or '').strip()
    if new_zone and any(isinstance(i, dict) and i.get('type') == 'POP' for i in items):
        zone = ops.save(db, user, dict(module='Zones', request_key=str(uuid.uuid5(batch, 'zone')), fields=dict(name=new_zone[:150])))['id']
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise ValueError('Invalid import row.')
        kind, name = item.get('type'), str(item.get('name') or 'Unnamed')[:150]
        notes = ('Imported from KMZ' + (' · ' + str(item.get('folder'))[:200] if item.get('folder') else '') + ('\n' + str(item.get('description'))[:300] if item.get('description') else ''))
        key = str(uuid.uuid5(batch, str(index)))
        try:
            if kind == 'POP':
                if not zone:
                    raise ValueError('Choose the zone for imported POPs.')
                ops.save(db, user, dict(module='POPs', request_key=key, fields=dict(name=name, zone=zone, address='', latitude=item.get('latitude'), longitude=item.get('longitude'))))
                made['POPs'] += 1
            elif kind in DEVICE_TYPES:
                ops.save(db, user, dict(module='Network devices', request_key=key, fields=dict(name=name, type=kind, latitude=item.get('latitude'), longitude=item.get('longitude'), notes=notes)))
                made['devices'] += 1
            elif kind == 'Fiber cable':
                points = item.get('points') if isinstance(item.get('points'), list) else []
                route = '\n'.join(f'{p[0]}, {p[1]}' for p in points if isinstance(p, list) and len(p) == 2)
                ops.save(db, user, dict(module='Fiber segments', request_key=key, fields=dict(
                    name=name, cable_type=item.get('cable_type'), core_count=item.get('cores'), status=item.get('status'), route=route, notes=notes)))
                made['cables'] += 1
            elif kind != 'Skip':
                raise ValueError('Choose what this item is, or Skip.')
        except ValueError as exc:
            raise ValueError(f'{name}: {exc}')
    return made

"""Device label photos saved with stock issues, and the make/model/MAC/serial typed or read from them.

The label is read in the browser (web/device-label.js); the server only validates and stores.
"""
import base64
import re

MAX_PHOTO = 5 * 1024 * 1024
FIELDS = ('device_make', 'device_model', 'device_mac', 'device_serial')


def decode_photo(value):
    """Validate a base64 (or data-URL) JPEG/PNG/WebP photo and return (bytes, media type)."""
    if not isinstance(value, str) or not value:
        raise ValueError('Add a device photo.')
    encoded = value.split(',', 1)[1] if value.startswith('data:') else value
    if len(encoded) > ((MAX_PHOTO + 2) // 3) * 4:
        raise ValueError('The device photo must be 5 MB or smaller.')
    try:
        content = base64.b64decode(encoded, validate=True)
    except ValueError:
        raise ValueError('The device photo could not be read.')
    if content.startswith(b'\xff\xd8\xff'):
        return content, 'image/jpeg'
    if content.startswith(b'\x89PNG\r\n\x1a\n'):
        return content, 'image/png'
    if content[:4] == b'RIFF' and content[8:12] == b'WEBP':
        return content, 'image/webp'
    raise ValueError('Use a JPEG, PNG or WebP photo.')


def clean_mac(value):
    hex_digits = re.sub(r'[^0-9A-Fa-f]', '', value or '')
    return ':'.join(hex_digits[i:i + 2] for i in range(0, 12, 2)).upper() if len(hex_digits) == 12 else (value or '').strip().upper()


def device_fields(fields):
    """Make, model, MAC and serial from a form, trimmed and length-checked."""
    result = {}
    for name in FIELDS:
        value = str(fields.get(name) or '').strip()
        if len(value) > 100:
            raise ValueError('Device details must be 100 characters or fewer.')
        result[name] = clean_mac(value) if name == 'device_mac' and value else value
    return result

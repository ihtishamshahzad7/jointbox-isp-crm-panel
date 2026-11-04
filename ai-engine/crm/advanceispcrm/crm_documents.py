"""Private, size-limited customer documents stored in PostgreSQL."""
import base64
import binascii

DOCUMENT_TYPES = ['Identity - front', 'Identity - back', 'Application form', 'Installation photo', 'Agreement', 'Other']
MAX_FILE = 5 * 1024 * 1024
MAX_TOTAL = 20 * 1024 * 1024
MAX_REQUEST = 30 * 1024 * 1024
METADATA = 'id,customer_id,document_type,original_name,mime_type,byte_size,uploaded_by,uploaded_at'


def permitted(user):
    return user['role'] in ('Administrator', 'Manager', 'Support')


def validate_uploads(documents):
    if not isinstance(documents, list) or len(documents) > 5:
        raise ValueError('Choose up to 5 documents per upload.')
    result, total = [], 0
    for document in documents:
        if not isinstance(document, dict):
            raise ValueError('Invalid document.')
        name = document.get('name', '')
        if not isinstance(name, str):
            raise ValueError('Invalid document filename.')
        name = name.replace('\\', '/').split('/')[-1].strip()
        if not name or len(name) > 180 or any(ord(c) < 32 for c in name):
            raise ValueError('Document names must be 1–180 characters without control characters.')
        kind = document.get('document_type', 'Other')
        if kind not in DOCUMENT_TYPES:
            raise ValueError('Select a valid document type.')
        encoded = document.get('content', '')
        if not isinstance(encoded, str) or len(encoded) > ((MAX_FILE + 2) // 3) * 4:
            raise ValueError('Each document must be at most 5 MB.')
        try:
            content = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            raise ValueError('Could not decode the document. Choose the file again.')
        if not content or len(content) > MAX_FILE:
            raise ValueError('Each document must contain data and be at most 5 MB.')
        extension = name.rsplit('.', 1)[-1].lower()
        if extension == 'pdf' and content.startswith(b'%PDF-'):
            mime = 'application/pdf'
        elif extension == 'png' and content.startswith(b'\x89PNG\r\n\x1a\n'):
            mime = 'image/png'
        elif extension in ('jpg', 'jpeg') and content.startswith(b'\xff\xd8\xff'):
            mime = 'image/jpeg'
        elif extension == 'webp' and content.startswith(b'RIFF') and content[8:12] == b'WEBP':
            mime = 'image/webp'
        else:
            raise ValueError('Only PDF, JPG, PNG, and WebP documents with matching file content are accepted.')
        total += len(content)
        if total > MAX_TOTAL:
            raise ValueError('Documents in one upload must total at most 20 MB.')
        result.append((kind, name, mime, len(content), content))
    return result


def store_documents(db, customer_id, user_id, documents):
    for kind, name, mime, size, content in documents:
        db.execute('''INSERT INTO customer_documents(customer_id,document_type,original_name,mime_type,byte_size,content,uploaded_by)
            VALUES (%s,%s,%s,%s,%s,%s,%s)''', (customer_id, kind, name, mime, size, content, user_id))

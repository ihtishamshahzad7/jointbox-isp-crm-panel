"""Cookie-aware administrator client for isolated integration tests."""
import http.cookiejar
import json
import urllib.request


def administrator_client(base):
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    with opener.open(base + '/api/auth/status') as response:
        status = json.load(response)
    request = urllib.request.Request(base + '/api/auth/setup',
        data=json.dumps({'name':'Test administrator', 'username':'test-admin', 'password':'test-admin-password'}).encode(),
        headers={'Content-Type':'application/json', 'X-CRM-Token':status['token']})
    with opener.open(request) as response:
        token = json.load(response)['token']
    return opener, token

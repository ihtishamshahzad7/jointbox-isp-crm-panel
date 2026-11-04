"""Keep the laptop-hosted dummy CRM and its public demo tunnel running together."""
from pathlib import Path
import ctypes,json,re,shutil,socket,subprocess,sys,time,urllib.request

ROOT=Path(__file__).resolve().parent
CREATE_NO_WINDOW=getattr(subprocess,'CREATE_NO_WINDOW',0)

def main():
    executable=shutil.which('cloudflared')
    if not executable:raise SystemExit('cloudflared is not installed.')
    with socket.socket() as probe:
        if probe.connect_ex(('127.0.0.1',3001))==0:
            raise SystemExit('Port 3001 is already in use. Stop the previous demo launcher first.')
    server=None;tunnel=None
    serverlog=(ROOT/'.demo-server.log').open('w',encoding='utf-8')
    tunnellog=(ROOT/'.demo-tunnel.log').open('w',encoding='utf-8')
    try:
        if sys.platform=='win32':ctypes.windll.kernel32.SetThreadExecutionState(0x80000001)
        server=subprocess.Popen([sys.executable,'-u',str(ROOT/'share_demo.py')],cwd=ROOT,stdout=serverlog,stderr=subprocess.STDOUT,creationflags=CREATE_NO_WINDOW)
        print('Preparing isolated dummy CRM...',flush=True)
        ready=False
        for _ in range(180):
            if server.poll() is not None:raise RuntimeError('Demo startup failed. See .demo-server.log.')
            try:
                with urllib.request.urlopen('http://127.0.0.1:3001/api/auth/status',timeout=2) as response:
                    if response.status==200:ready=True;break
            except OSError:time.sleep(1)
        if not ready:raise RuntimeError('Demo did not start in time.')
        tunnel=subprocess.Popen([executable,'tunnel','--url','http://127.0.0.1:3001','--no-autoupdate','--protocol','http2'],cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,encoding='utf-8',errors='replace',creationflags=CREATE_NO_WINDOW)
        (ROOT/'DEMO_LINK.txt').write_text('Demo sharing is connecting. Wait for the public URL.\n',encoding='utf-8')
        print('Connecting public demo tunnel...',flush=True)
        for line in tunnel.stdout:
            tunnellog.write(line);tunnellog.flush()
            match=re.search(r'https://(?!api\.)[a-z0-9-]+\.trycloudflare\.com',line)
            if match:
                demo=json.loads((ROOT/'.demo-share.local.json').read_text(encoding='utf-8'))
                details=f"ISP CRM TEST DEMO\n\nLink: {match.group()}\nUsername: demo-reviewer\nPassword: {demo['password']}\n\nDummy data only. Keep the laptop online and this launcher running.\nWindows automatic sleep is prevented while this launcher is running.\nRestarting the tunnel creates a different URL; this file will be updated.\nPress Ctrl+C in the launcher to stop sharing.\n"
                (ROOT/'DEMO_LINK.txt').write_text(details,encoding='utf-8')
                print(details,flush=True)
            if server.poll() is not None:raise RuntimeError('Demo server stopped. See .demo-server.log.')
        raise RuntimeError('Tunnel stopped. See .demo-tunnel.log. Restart start_demo_share.cmd to reconnect.')
    except KeyboardInterrupt:
        print('Stopping demo sharing...',flush=True)
    finally:
        for process in (tunnel,server):
            if process is not None and process.poll() is None:
                process.terminate()
                try:process.wait(timeout=8)
                except subprocess.TimeoutExpired:process.kill()
        serverlog.close();tunnellog.close()
        if sys.platform=='win32':ctypes.windll.kernel32.SetThreadExecutionState(0x80000000)

if __name__=='__main__':main()

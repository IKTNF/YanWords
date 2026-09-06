# -*- coding: utf-8 -*-
"""研词助手 · 本地服务（静态文件 + 有道词典在线代理）——无 Node.js 时的备用方案"""
import http.server, socketserver, os, json, urllib.request, urllib.parse

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'www')
PORT = 8765
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
MIME = {'.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
        '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
        '.otf':'font/otf', '.ttf':'font/ttf', '.woff':'font/woff', '.woff2':'font/woff2',
        '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.ico':'image/x-icon',
        '.txt':'text/plain; charset=utf-8', '.md':'text/plain; charset=utf-8'}

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        try:
            u = urllib.parse.urlparse(self.path)
            p = urllib.parse.unquote(u.path)
            if p.startswith('/api/dict'):
                q = urllib.parse.parse_qs(u.query).get('q', [''])[0].strip()
                if not q:
                    self._json(400, {'error': '缺少参数 q'}); return
                api = ('https://dict.youdao.com/jsonapi?q=' + urllib.parse.quote(q)
                       + '&dicts=' + urllib.parse.quote('{"count":99,"dicts":[["ec","blng_sents_part","web_trans"]]}'))
                req = urllib.request.Request(api, headers={'User-Agent': UA, 'Referer': 'https://dict.youdao.com/'})
                data = urllib.request.urlopen(req, timeout=10).read()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(data)
                return
            if p == '/api/health':
                self._json(200, {'ok': True}); return
            if p == '/':
                p = '/index.html'
            fp = os.path.normpath(os.path.join(ROOT, p.lstrip('/')))
            if not (fp == ROOT or fp.startswith(ROOT + os.sep)) or not os.path.isfile(fp):
                self.send_response(404); self.send_header('Content-Type', 'text/plain; charset=utf-8'); self.end_headers()
                self.wfile.write(b'404 Not Found'); return
            ext = os.path.splitext(fp)[1].lower()
            self.send_response(200)
            self.send_header('Content-Type', MIME.get(ext, 'application/octet-stream'))
            self.send_header('Content-Length', str(os.path.getsize(fp)))
            self.end_headers()
            with open(fp, 'rb') as f:
                self.wfile.write(f.read())
        except Exception as e:
            try:
                self._json(500, {'error': str(e)})
            except Exception:
                pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

if __name__ == '__main__':
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    print('')
    print('  📖 研词助手 · 考研英语一词汇工作台 已启动')
    print('  地址: http://127.0.0.1:%d/' % PORT)
    print('  关闭本窗口（Ctrl+C）即退出程序。')
    print('')
    socketserver.ThreadingTCPServer(('127.0.0.1', PORT), H).serve_forever()

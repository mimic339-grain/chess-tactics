# ゲームを http://localhost:8765 で開くための小さなサーバー
# ブラウザが古いファイルを使い回さないように、毎回最新のファイルを読ませる（キャッシュ無効）
# ネット対戦の部屋（合言葉で入る）もこのサーバーが中継する
#   使い方: python serve.py [ポート番号] [--public]
#   --public を付けると同じ Wi-Fi の別の端末からも入れる（トンネルを使うなら付けなくてよい）
import functools
import http.server
import json
import os
import random
import sys
import threading
import time
from urllib.parse import urlparse, parse_qs

rooms = {}                  # 合言葉 → 部屋
rooms_lock = threading.Lock()
changed = threading.Condition(rooms_lock)
ROOM_LIFETIME = 6 * 3600    # 6時間さわられていない部屋は消す


def new_code():
    letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'  # 見間違えやすい I O 0 1 は使わない
    while True:
        code = ''.join(random.choice(letters) for _ in range(4))
        if code not in rooms:
            return code


def room_view(room):
    return {'version': room['version'], 'decks': room['decks'], 'state': room['state'],
            'joined': room['joined'], 'watchers': room['watchers']}


def cleanup():
    now = time.time()
    for code in [c for c, r in rooms.items() if now - r['touched'] > ROOM_LIFETIME]:
        del rooms[code]


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        if '/api/' not in self.path:  # 部屋の問い合わせは多いので表示しない
            super().log_message(fmt, *args)

    def send_json(self, data, status=200):
        body = json.dumps(data).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        n = int(self.headers.get('Content-Length') or 0)
        return json.loads(self.rfile.read(n) or b'{}')

    # 部屋の様子を見る。since より新しくなるまで最大 25 秒待ってから返す
    def do_GET(self):
        url = urlparse(self.path)
        parts = url.path.strip('/').split('/')
        if parts[:2] != ['api', 'room'] or len(parts) != 3:
            return super().do_GET()
        code = parts[2].upper()
        since = int(parse_qs(url.query).get('since', ['-1'])[0])
        with changed:
            room = rooms.get(code)
            if not room:
                return self.send_json({'error': 'その部屋はありません'}, 404)
            end = time.time() + 25
            while room['version'] <= since and time.time() < end:
                changed.wait(end - time.time())
            room['touched'] = time.time()
            self.send_json(room_view(room))

    def do_POST(self):
        parts = urlparse(self.path).path.strip('/').split('/')
        try:
            data = self.read_json()
        except ValueError:
            return self.send_json({'error': 'bad json'}, 400)
        with changed:
            cleanup()
            # 部屋を作る：作った人が白
            if parts == ['api', 'create']:
                code = new_code()
                rooms[code] = {'version': 0, 'decks': {}, 'state': None, 'joined': {'w': True, 'b': False},
                               'watchers': 0, 'touched': time.time()}
                return self.send_json({'code': code, 'color': 'w'})
            # 合言葉で入る：2人目が黒、3人目からは観戦
            if parts == ['api', 'join']:
                code = str(data.get('code', '')).upper().strip()
                room = rooms.get(code)
                if not room:
                    return self.send_json({'error': 'その合言葉の部屋はありません'}, 404)
                if not room['joined']['b']:
                    room['joined']['b'] = True
                    color = 'b'
                else:
                    room['watchers'] += 1
                    color = 'watch'
                room['version'] += 1
                changed.notify_all()
                return self.send_json({'code': code, 'color': color})
            if len(parts) == 4 and parts[:2] == ['api', 'room']:
                room = rooms.get(parts[2].upper())
                if not room:
                    return self.send_json({'error': 'その部屋はありません'}, 404)
                # デッキを送る
                if parts[3] == 'deck':
                    color = data.get('color')
                    if color not in ('w', 'b'):
                        return self.send_json({'error': 'bad color'}, 400)
                    room['decks'][color] = data.get('deck')
                # 盤面を送る（行動するたびに、行動した側が送る）
                elif parts[3] == 'state':
                    room['state'] = data.get('state')
                # もう一度遊ぶ：盤面とデッキを消して編成からやり直す
                elif parts[3] == 'reset':
                    room['state'] = None
                    room['decks'] = {}
                else:
                    return self.send_json({'error': 'unknown'}, 404)
                room['version'] += 1
                room['touched'] = time.time()
                changed.notify_all()
                return self.send_json({'version': room['version']})
        self.send_json({'error': 'unknown'}, 404)


port = int(next((a for a in sys.argv[1:] if a.isdigit()), 8765))
host = '0.0.0.0' if '--public' in sys.argv else '127.0.0.1'
root = os.path.dirname(os.path.abspath(__file__))
handler = functools.partial(Handler, directory=root)
print(f'http://localhost:{port} で起動中（Ctrl+C で終了）')
http.server.ThreadingHTTPServer((host, port), handler).serve_forever()

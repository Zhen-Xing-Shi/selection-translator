#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""划词翻译助手
用法:
    translate.py <文本>        查询并输出 JSON
    translate.py --build-index 构建变形词索引（安装时执行一次）
    translate.py --selftest    自检
单词 -> 本地 ECDICT 离线词库（音标 + 中英释义 + 词形变化）
句子 -> 有道网页翻译（备选 MyMemory）
中文   -> 在线翻译成英文
"""
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
import urllib.parse
import urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(BASE, 'ecdict.db')
UA = ('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')

WORD_RE = re.compile(r"^[A-Za-z][A-Za-z'\-]*$")
CJK_RE = re.compile(r'[一-鿿]')

EXCHANGE_NAMES = {
    'p': '过去式', 'd': '过去分词', 'i': '现在分词', '3': '第三人称单数',
    's': '复数', 'r': '比较级', 't': '最高级',
}
FIELDS = 'word,phonetic,pos,translation,definition,collins,tag,exchange'


def emit(obj):
    json.dump(obj, sys.stdout, ensure_ascii=False)
    sys.stdout.write('\n')


def error(msg):
    return {'kind': 'error', 'message': msg}


# ---------------- 本地词典 ----------------

def lookup(con, word):
    cur = con.execute(
        f'SELECT {FIELDS} FROM stardict WHERE word=? COLLATE NOCASE LIMIT 1',
        (word,))
    return cur.fetchone()


def build_index(con):
    """解析 exchange 字段，建立 变形词 -> 原型 的索引表。"""
    con.execute('CREATE TABLE IF NOT EXISTS forms('
                'form TEXT PRIMARY KEY COLLATE NOCASE, word TEXT)')
    n = 0
    for word, ex in con.execute(
            "SELECT word, exchange FROM stardict WHERE exchange <> ''"):
        for part in (ex or '').split('/'):
            if ':' not in part:
                continue
            code, val = part.split(':', 1)
            val = val.strip()
            if code in EXCHANGE_NAMES and val and val.lower() != word.lower():
                con.execute('INSERT OR IGNORE INTO forms(form, word) '
                            'VALUES(?, ?)', (val, word))
                n += 1
    con.commit()
    return n


def lemma_via_forms(con, word):
    try:
        cur = con.execute('SELECT word FROM forms WHERE form=? '
                          'COLLATE NOCASE LIMIT 1', (word,))
        row = cur.fetchone()
        return row[0] if row else None
    except sqlite3.OperationalError:
        return None


def lemma_via_rules(con, word):
    cands = []
    if word.endswith("'s"):
        cands.append(word[:-2])
    if word.endswith('ies') and len(word) > 3:
        cands.append(word[:-3] + 'y')
    if word.endswith('es'):
        cands += [word[:-2], word[:-1]]
    elif word.endswith('s') and not word.endswith('ss'):
        cands.append(word[:-1])
    if word.endswith('ing') and len(word) > 4:
        cands += [word[:-3], word[:-3] + 'e', word[:-4]]
    if word.endswith('ed') and len(word) > 3:
        cands += [word[:-2], word[:-1]]
    if word.endswith('er') and len(word) > 3:
        cands += [word[:-2], word[:-2] + 'e']
    if word.endswith('est') and len(word) > 4:
        cands += [word[:-3], word[:-3] + 'e']
    for c in cands:
        if lookup(con, c):
            return c
    return None


def clean_lines(text):
    if not text:
        return []
    return [ln.strip() for ln in text.replace('\r', '').split('\n')
            if ln.strip()]


def query_word(query):
    if not os.path.exists(DB):
        return error('词典数据库缺失: ' + DB)
    con = sqlite3.connect(DB)
    try:
        w = query.lower()
        row = lookup(con, w)
        lemma = None
        if row is None:
            lemma = lemma_via_forms(con, w) or lemma_via_rules(con, w)
            if lemma:
                row = lookup(con, lemma)
        if row is None:
            return None
        word, phonetic, pos, trans, defin, collins, tag, exchange = row
        result = {
            'kind': 'word',
            'query': query,
            'word': word,
            'lemma': lemma,
            'phonetic': (phonetic or '').strip(),
            'pos': (pos or '').strip(),
            'collins': collins or 0,
            'tag': (tag or '').strip(),
            'translation': clean_lines(trans),
            'definition': clean_lines(defin),
            'exchange': [],
        }
        items = []
        for part in (exchange or '').split('/'):
            if ':' not in part:
                continue
            code, val = part.split(':', 1)
            if code in EXCHANGE_NAMES and val.strip():
                items.append('%s: %s' % (EXCHANGE_NAMES[code], val.strip()))
        result['exchange'] = items
        return result
    finally:
        con.close()


# ---------------- 在线翻译 ----------------

def http_get(url, timeout=10):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def _md5(s):
    return hashlib.md5(s.encode('utf-8')).hexdigest()


_YD_KEY_CACHE = os.path.join(os.path.expanduser('~'), '.cache',
                             'selection-translator', 'ydkey.json')
_YD_KEY_TTL = 300  # 秒
_YD_DEFAULT_KEY = 'yU5nT5dK3eZ1pI4j'
_YD_COOKIE = ('OUTFOX_SEARCH_USER_ID=-959393723@218.1.219.199; '
              'OUTFOX_SEARCH_USER_ID_NCOO=106810021.57668559')


def _yd_headers():
    return {'User-Agent': UA, 'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Origin': 'https://fanyi.youdao.com',
            'Referer': 'https://fanyi.youdao.com/', 'Cookie': _YD_COOKIE}


def _yd_auth(sign, ts):
    return {'client': 'fanyideskweb', 'product': 'webfanyi',
            'appVersion': '1.0.0', 'vendor': 'web',
            'pointParam': 'client,mysticTime,product', 'mysticTime': ts,
            'keyfrom': 'fanyi.web', 'mid': '1', 'screen': '1', 'model': '1',
            'network': 'wifi', 'abtest': '0', 'yduuid': 'abcdefg',
            'sign': sign}


def _youdao_keys():
    """获取 webtranslate 接口的动态密钥（5 分钟缓存）。"""
    try:
        with open(_YD_KEY_CACHE, encoding='utf-8') as f:
            cache = json.load(f)
        if time.time() - cache.get('ts', 0) < _YD_KEY_TTL:
            return cache['secretKey'], cache['aesKey'], cache['aesIv']
    except Exception:  # noqa: BLE001
        pass
    ts = str(int(time.time() * 1000))
    sign = _md5('client=fanyideskweb&mysticTime=%s&product=webfanyi'
                '&key=%s' % (ts, _YD_DEFAULT_KEY))
    params = {'keyid': 'webfanyi-key-getter-2025', **_yd_auth(sign, ts)}
    req = urllib.request.Request(
        'https://dict.youdao.com/webtranslate/key?'
        + urllib.parse.urlencode(params), headers=_yd_headers())
    with urllib.request.urlopen(req, timeout=10) as r:
        obj = json.loads(r.read().decode('utf-8'))
    data = obj.get('data') or {}
    secret_key = data.get('secretKey')
    aes_key, aes_iv = data.get('aesKey'), data.get('aesIv')
    if not secret_key or not aes_key or not aes_iv:
        raise RuntimeError('youdao 密钥获取失败: %s' % str(obj)[:200])
    try:
        os.makedirs(os.path.dirname(_YD_KEY_CACHE), exist_ok=True)
        with open(_YD_KEY_CACHE, 'w', encoding='utf-8') as f:
            json.dump({'ts': time.time(), 'secretKey': secret_key,
                       'aesKey': aes_key, 'aesIv': aes_iv}, f)
    except Exception:  # noqa: BLE001
        pass
    return secret_key, aes_key, aes_iv


def _youdao_request(text):
    """调用有道 webtranslate，返回解密后的完整 JSON 对象。"""
    import base64
    from Crypto.Cipher import AES

    secret_key, aes_key, aes_iv = _youdao_keys()
    ts = str(int(time.time() * 1000))
    sign = _md5('client=fanyideskweb&mysticTime=%s&product=webfanyi'
                '&key=%s' % (ts, secret_key))
    auth = _yd_auth(sign, ts)
    form = {'i': text, 'from': 'auto', 'to': '', 'useTerm': 'false',
            'domain': '0', 'dictResult': 'true', 'keyid': 'webfanyi',
            **auth}
    headers = {**_yd_headers(),
               'Content-Type': 'application/x-www-form-urlencoded',
               **auth}
    req = urllib.request.Request(
        'https://dict.youdao.com/webtranslate',
        data=urllib.parse.urlencode(form).encode('utf-8'),
        headers=headers)
    with urllib.request.urlopen(req, timeout=10) as r:
        body = r.read().decode('utf-8').strip()
    if body.startswith('{'):
        return json.loads(body)
    raw = base64.urlsafe_b64decode(body + '=' * (-len(body) % 4))
    cipher = AES.new(hashlib.md5(aes_key.encode()).digest(),
                     AES.MODE_CBC, hashlib.md5(aes_iv.encode()).digest())
    plain = cipher.decrypt(raw)
    plain = plain[:-plain[-1]]  # PKCS7 unpad
    return json.loads(plain.decode('utf-8'))


def youdao(text):
    obj = _youdao_request(text)
    if obj.get('code') != 0:
        raise RuntimeError('youdao code=%s' % obj.get('code'))
    lines = obj.get('translateResult') or []
    out = []
    for line in lines:
        if isinstance(line, list):
            out.extend(seg.get('tgt', '') for seg in line)
        elif isinstance(line, dict):
            out.append(line.get('tgt', ''))
    result = ''.join(out).strip()
    if not result:
        raise RuntimeError('youdao 空结果')
    return result


def youdao_word_online(query):
    """本地词库未命中时的在线查词（含音标）。"""
    obj = _youdao_request(query)
    if obj.get('code') != 0:
        return None
    ec = (obj.get('dictResult') or {}).get('ec') or {}
    word_info = ec.get('word') or {}
    trs = word_info.get('trs') or []
    if not trs:
        return None
    translation = ['%s %s' % (t.get('pos', ''), t.get('tran', '')).strip()
                   for t in trs if t.get('tran')]
    phonetic = word_info.get('usphone') or word_info.get('ukphone') or ''
    exchange = ['%s: %s' % (w['wf']['name'], w['wf']['value'])
                for w in (word_info.get('wfs') or [])
                if isinstance(w, dict) and w.get('wf')]
    return {'kind': 'word', 'query': query, 'word': query, 'lemma': None,
            'phonetic': phonetic, 'pos': '', 'collins': 0,
            'tag': ' '.join(ec.get('exam_type') or []),
            'translation': translation, 'definition': [],
            'exchange': exchange, 'online': True}


def mymemory(text, src, dst):
    pair = ('zh-CN' if src.startswith('zh') else src) + '|' + \
           ('zh-CN' if dst.startswith('zh') else dst)
    url = 'https://api.mymemory.translated.net/get?' + urllib.parse.urlencode(
        {'q': text, 'langpair': pair})
    obj = http_get(url)
    out = obj.get('responseData', {}).get('translatedText', '')
    if not out:
        raise RuntimeError('mymemory 无结果')
    return out


def translate_text(text):
    is_cjk = bool(CJK_RE.search(text))
    src, dst = ('zh-CHS', 'en') if is_cjk else ('en', 'zh-CHS')
    last_err = None
    try:
        out = youdao(text).strip()
        if out and out.lower() != text.lower():
            return {'kind': 'sentence', 'source': text,
                    'translation': out, 'engine': 'youdao'}
    except Exception as e:  # noqa: BLE001
        last_err = e
    try:
        out = mymemory(text, src, dst).strip()
        if out and out.lower() != text.lower():
            return {'kind': 'sentence', 'source': text,
                    'translation': out, 'engine': 'mymemory'}
    except Exception as e:  # noqa: BLE001
        last_err = e
    return error('在线翻译失败: %s' % last_err)


# ---------------- 入口 ----------------

def query(text):
    text = ' '.join((text or '').split())
    if not text:
        return error('空文本')
    if len(text) > 2000:
        return error('文本过长（>2000 字符）')
    if WORD_RE.match(text):
        result = query_word(text)
        if result is not None:
            return result
        # 本地词库未收录 -> 有道在线词典（含音标）
        try:
            result = youdao_word_online(text)
            if result is not None:
                return result
        except Exception:  # noqa: BLE001
            pass
    return translate_text(text)


def selftest():
    checks = []
    for word in ('hello', 'running', 'went', 'studies'):
        r = query_word(word)
        ok = bool(r and r.get('kind') == 'word' and r.get('translation'))
        checks.append((word, ok, (r or {}).get('word'),
                       (r or {}).get('phonetic')))
    return checks


if __name__ == '__main__':
    if len(sys.argv) >= 2 and sys.argv[1] == '--build-index':
        if not os.path.exists(DB):
            print('数据库不存在: ' + DB, file=sys.stderr)
            sys.exit(1)
        con = sqlite3.connect(DB)
        con.execute('CREATE INDEX IF NOT EXISTS idx_stardict_word '
                    'ON stardict(word COLLATE NOCASE)')
        n = build_index(con)
        con.close()
        print('索引完成，变形词条目: %d' % n)
    elif len(sys.argv) >= 2 and sys.argv[1] == '--selftest':
        for word, ok, hit, phonetic in selftest():
            print('%-10s %s  -> %s /%s/' % (word, 'OK ' if ok else 'FAIL',
                                            hit, phonetic))
    elif len(sys.argv) >= 2:
        emit(query(sys.argv[1]))
    else:
        print(__doc__)

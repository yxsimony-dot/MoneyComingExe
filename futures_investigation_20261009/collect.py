"""One-off public data capture. All timestamps in output are Asia/Shanghai.

EDB raw 1m bars have START labels. Aggregates use END labels and a
trading-minute clock: day 09:00-10:15,10:30-11:30,13:30-15:00; night21:00-23:00.
60m day ends 10:00,11:15,14:15,15:00 (last bar is 45 trading minutes).
No synthetic missing prices. No night-session trading-date inference.
"""
import csv, io, json, hashlib, math
from pathlib import Path
from datetime import datetime, timezone, timedelta
from collections import defaultdict, Counter
import urllib.request, urllib.parse, urllib.error
from types import SimpleNamespace

def request_get(url, params=None, headers=None, timeout=90):
    if params: url += '?' + urllib.parse.urlencode(params)
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}), timeout=timeout) as r:
            content=r.read(); status=r.status
    except urllib.error.HTTPError as e:
        content=e.read(); status=e.code
    def check():
        if status >= 400: raise RuntimeError(f'HTTP {status}: {content[:200]!r}')
    return SimpleNamespace(content=content,text=content.decode('utf-8'),status_code=status,url=url,raise_for_status=check)

requests = SimpleNamespace(get=request_get)

ROOT = Path(__file__).resolve().parent
TZ = timezone(timedelta(hours=8))
LOG = []

def fetch(name, url, params=None, headers=None):
    r = requests.get(url, params=params, headers=headers, timeout=90)
    (ROOT / name).write_bytes(r.content)
    LOG.append(dict(file=name, url=r.url, status=r.status_code,
                    fetched_at=datetime.now(TZ).isoformat(), bytes=len(r.content),
                    sha256=hashlib.sha256(r.content).hexdigest()))
    r.raise_for_status()
    return r.text

def write_csv(name, rows):
    with (ROOT / name).open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader(); w.writerows(rows)

def minute_clock(dt):
    m = dt.hour*60 + dt.minute
    for a,b,base in [(540,615,0),(630,690,75),(810,900,135)]:
        if a <= m < b: return 'day', m-a+base, 225
    if 1260 <= m < 1380: return 'night',m-1260,120
    raise ValueError(f'Unexpected session time {dt}')

def wall_minute(session, index):
    if session == 'night': return 1260+index
    # Start of the next traded minute; end labels handled from last minute+1.
    if index < 75: return 540+index
    if index < 135: return 630+index-75
    return 810+index-135

def aggregate(rows, period):
    groups = defaultdict(list)
    for row in rows:
        dt = row['_dt']; session, idx, total = minute_clock(dt)
        groups[(dt.date(),session,idx//period,total)].append(row)
    result=[]
    for (day,session,bucket,total), part in groups.items():
        start_idx=bucket*period; stop_idx=min(start_idx+period,total)
        begin=datetime.combine(day,datetime.min.time())+timedelta(minutes=wall_minute(session,start_idx))
        end=datetime.combine(day,datetime.min.time())+timedelta(minutes=wall_minute(session,stop_idx-1)+1)
        valid=all(all(math.isfinite(float(x[c])) for c in ['open','high','low','close','volume','open_oi','close_oi']) for x in part)
        result.append(dict(bar_start=str(begin),bar_end=str(end),session=session,
                           open=part[0]['open'], high=max(float(x['high']) for x in part),
                           low=min(float(x['low']) for x in part),close=part[-1]['close'],
                           volume=sum(int(float(x['volume'])) for x in part),
                           open_oi=part[0]['open_oi'],close_oi=part[-1]['close_oi'],
                           observed_minutes=len(part),expected_minutes=stop_idx-start_idx,
                           complete=len(part)==stop_idx-start_idx and valid))
    return sorted(result,key=lambda x:x['bar_start'])

summary={'date':'2026-10-09','timezone':'Asia/Shanghai','edb':{},'sina':{}}
for symbol,label in [('KQ.m@DCE.m','main_continuous'),('DCE.m2701','m2701')]:
    raw=fetch(f'edb_{label}_1m_raw.csv','https://edb.shinnytech.com/md/kline',dict(
        period=60,symbol=symbol,start_time='2025-10-09 21:00:00',
        end_time='2026-10-09 23:59:59',col='open,high,low,close,volume,open_oi,close_oi'))
    rows=list(csv.DictReader(io.StringIO(raw)))
    for row in rows:
        row['_dt']=datetime.fromtimestamp(int(row['datetime_nano'])//10**9,TZ)
    timestamps=[int(x['datetime_nano']) for x in rows]
    assert timestamps==sorted(set(timestamps)), 'Duplicate or nonmonotonic timestamps'
    invalid=sum(not(float(x['low'])<=min(float(x['open']),float(x['close']))<=max(float(x['open']),float(x['close']))<=float(x['high'])) for x in rows)
    entry=dict(symbol=symbol,one_minute_rows=len(rows),first=str(rows[0]['_dt']),last=str(rows[-1]['_dt']),
               duplicate_timestamps=0,invalid_ohlc=invalid,natural_dates=len({x['_dt'].date() for x in rows}))
    aggs={}
    for period in [5,60]:
        out=aggregate(rows,period); aggs[period]=out
        write_csv(f'edb_{label}_{period}m.csv',out)
        entry[str(period)+'m']=dict(rows=len(out),first_start=out[0]['bar_start'],last_end=out[-1]['bar_end'],
                complete=sum(x['complete'] for x in out),incomplete=sum(not x['complete'] for x in out),
                duration_counts=dict(Counter(x['expected_minutes'] for x in out)))
        assert sum(x['volume'] for x in out)==sum(int(float(x['volume'])) for x in rows)
    # Independent reconciliation: every 60m row reconstructed from contained 5m rows.
    for hour in aggs[60]:
        part=[x for x in aggs[5] if hour['bar_start']<=x['bar_start'] and x['bar_end']<=hour['bar_end']]
        assert sum(x['volume'] for x in part)==hour['volume']
        assert float(part[0]['open'])==float(hour['open']) and float(part[-1]['close'])==float(hour['close'])
        assert max(x['high'] for x in part)==hour['high'] and min(x['low'] for x in part)==hour['low']
    entry['reconciliation_5m_to_60m']='passed OHLC and volume for every bar'
    summary['edb'][label]=entry

for symbol in ['M0','M2701']:
    for period in [5,60]:
        raw=fetch(f'sina_{symbol}_{period}m_raw.jsonp','https://stock2.finance.sina.com.cn/futures/api/jsonp.php/=/InnerFuturesNewService.getFewMinLine',
                  dict(symbol=symbol,type=period),{'Referer':'https://finance.sina.com.cn/'})
        rows=json.loads(raw.split('=(',1)[1].rsplit(');',1)[0])
        mapping=dict(d='bar_end',o='open',h='high',l='low',c='close',v='volume',p='close_oi')
        out=[{mapping[k]:v for k,v in x.items()} for x in rows]
        write_csv(f'sina_{symbol}_{period}m.csv',out)
        summary['sina'][f'{symbol}_{period}m']=dict(rows=len(rows),first=rows[0]['d'],last=rows[-1]['d'],duplicates=len(rows)-len({x['d'] for x in rows}))

for period in [300,3600]:
    r=requests.get('https://edb.shinnytech.com/md/kline',params=dict(period=period,symbol='KQ.m@DCE.m',start_time='2026-10-08 09:00:00',end_time='2026-10-08 15:00:00'),timeout=30)
    LOG.append(dict(test='unsupported_period',url=r.url,status=r.status_code,body=r.text[:500]))
r=requests.get('https://edb.shinnytech.com/md/kline',params=dict(period=60,symbol='KQ.m@DCE.m',start_time='2025-10-09 00:00:00',end_time='2025-10-09 15:00:00'),timeout=30)
LOG.append(dict(test='free_history_boundary',url=r.url,status=r.status_code,body=r.text[:500]))
(ROOT/'request_manifest.json').write_text(json.dumps(LOG,ensure_ascii=False,indent=2),encoding='utf-8')
(ROOT/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(summary,ensure_ascii=False,indent=2))
print(json.dumps(LOG[-3:],ensure_ascii=False,indent=2))

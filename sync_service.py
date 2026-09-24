'''
sync_service.py ~ 背景即時同步

以背景執行緒每隔 interval 秒下載一次官方即時資料，更新到 repository，
並 (選擇性) 另存一份 CSV 快照，讓下次啟動時就算沒網路也有較新的資料。

就像物聯網系統中「定期輪詢感測器 → 更新資料庫」的資料流。
'''

import threading
import time

from repository import now_str
from youbike_source import fetch_official, normalize, save_csv


class SyncService:

    def __init__(self, repo, interval=60, fetcher=fetch_official, snapshot_path=None, logger=None):
        self.repo = repo
        self.interval = interval
        self.fetcher = fetcher              # 可注入假資料來源，方便測試
        self.snapshot_path = snapshot_path
        self.logger = logger
        self._stop = threading.Event()
        self._thread = None
        self._run_lock = threading.Lock()   # 避免排程同步與手動同步同時執行
        self.status = {
            'enabled': False,
            'interval_sec': interval,
            'last_attempt': None,
            'last_success': None,
            'last_error': None,
            'last_result': None,
            'success_count': 0,
            'error_count': 0,
        }

    def _log(self, level, msg, *args):
        if self.logger:
            getattr(self.logger, level)(msg, *args)

    def run_once(self):
        '''立即同步一次。成功回傳結果 dict，失敗丟出例外 (狀態也會記錄)。'''
        with self._run_lock:
            self.status['last_attempt'] = now_str()
            started = time.perf_counter()
            try:
                raw = self.fetcher()
                stations = [normalize(r) for r in raw if r.get('sno')]
                result = self.repo.upsert_official(stations)
                result['fetched'] = len(stations)
                result['elapsed_ms'] = round((time.perf_counter() - started) * 1000)
                if self.snapshot_path:
                    save_csv(self.repo.all(), self.snapshot_path)
                self.status.update(last_success=now_str(), last_error=None, last_result=result)
                self.status['success_count'] += 1
                self._log('info', 'YouBike sync ok: %s', result)
                return result
            except Exception as exc:
                self.status['last_error'] = f'{type(exc).__name__}: {exc}'
                self.status['error_count'] += 1
                self._log('warning', 'YouBike sync failed: %s', exc)
                raise

    def _loop(self):
        while not self._stop.is_set():
            try:
                self.run_once()
            except Exception:
                pass                        # 錯誤已記錄在 status，下一輪再試
            self._stop.wait(self.interval)

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self.status['enabled'] = True
        self._thread = threading.Thread(target=self._loop, name='youbike-sync', daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        self.status['enabled'] = False

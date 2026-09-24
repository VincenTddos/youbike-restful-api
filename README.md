# 臺北市 YouBike 2.0 RESTful API

物聯網應用 W03 課後作業：以「應用 Flask 框架，執行 HTTP Server 以提供 RESTful API 服務」範例為基礎，
結合政府公開資料 [YouBike2.0 臺北市公共自行車即時資訊](https://data.gov.tw/dataset/137993) 進行功能擴增及優化。

## 快速開始

```bash
pip install -r requirements.txt

python youbike_source.py      # (建議) 下載完整即時快照 → data/youbike_stations.csv，約 1,800 站
python rest_server.py         # 啟動 Server：匯入 CSV + 每 60 秒背景同步
```

用瀏覽器打開 `client/index.html` 就能使用網頁介面。

- 沒有先下載完整快照的話，Server 會改用隨附的 `data/youbike_sample.csv`（86 站範例）。
- 沒有網路時請執行 `python rest_server.py --no-sync`，只使用 CSV 裡的資料。
- 其他參數：`--csv 檔案`、`--interval 30`、`--port 5000`

## 檔案結構

| 檔案 | 職責 |
|---|---|
| `youbike_source.py` | 下載官方 JSON、欄位轉換、CSV 讀寫 |
| `repository.py` | 資料存取層：`StationRepository` 抽象介面與 `DictStationRepository` 實作 |
| `sync_service.py` | 背景同步執行緒，定期抓官方資料並更新 |
| `rest_server.py` | Flask 路由與輸入驗證 |
| `client/` | 網頁 Client（HTML、CSS、JS 分成三個檔案） |
| `test_rest_server.py` | 42 項自動化測試（`pytest -v`，不需要網路） |
| `curl_test.bat` | curl 測試腳本（Windows） |

## 資料流

```
政府開放資料 (JSON, 每分鐘更新)
      │  sync_service 每 60 秒抓取 (背景執行緒)
      ▼
normalize() 欄位轉換 ──► DictStationRepository (記憶體, Lock 保護) ◄── Flask 路由 ◄── Client / curl
      ▲                         │
 啟動時 load_csv()          每次同步後 save_csv()
      └──── data/youbike_stations.csv ◄┘
```

## API

| 功能 | Method | URL |
|---|---|---|
| 查詢站點（篩選/排序/分頁） | GET | `/stations?area=&q=&min_rent=&min_return=&active=&sort=&limit=&offset=` |
| 查詢單一站點 | GET | `/stations/<sno>` |
| 新增站點 | POST | `/stations` |
| 整筆改換 | PUT | `/stations/<sno>` |
| 部份更新 | PATCH | `/stations/<sno>` |
| 刪除 | DELETE | `/stations/<sno>` |
| 附近站點 | GET | `/stations/nearby?lat=&lng=&r=500&limit=10&need=rent\|return` |
| 行政區列表 | GET | `/areas` |
| 統計 | GET | `/stats?low=2` |
| 同步狀態 / 立即同步 | GET / POST | `/sync/status`、`/sync` |

`sort` 可用 `sno`、`name`、`area`、`total`、`available_rent`、`available_return`，前面加 `-` 代表遞減。

站點欄位：`sno`、`name`、`area`、`address`、`lat`、`lng`、`total`、`available_rent`、`available_return`、`active`、`updated_at`、`source`（`official` 或 `custom`）。

狀態碼：200、201 新增成功、400 輸入錯誤、404 找不到、409 編號重複、502 同步失敗。

## 相較原範例的擴增及優化

**Server**

1. **物件導向改造**：原本的 dict 和 CRUD 程式碼封裝成 `StationRepository` 抽象介面加上 dict 實作，路由只負責呼叫。之後改接 MariaDB，只要新增 `MariaDBStationRepository`。
2. **公開資料整合**：啟動時匯入 CSV，官方欄位（`sna`、`sarea`、`Quantity`…）轉成一致的 API 欄位。CSV 可以用 Excel 開啟和編輯。
3. **即時同步**：背景執行緒定期更新資料，用 `threading.RLock` 避免和 API 請求互相衝突。同步後會另存 CSV 快照，下次離線啟動也有較新的資料。自建的站點不會被同步覆蓋。
4. **空間查詢**：用 Haversine 公式算出兩點之間的實際距離，先以緯度差粗略篩選，減少計算量，再依距離排序。
5. **統計端點**：提供各行政區的可借數量與比例，以及快沒車、已滿位的站點清單。
6. **RESTful 路由設計**：原本是 `/fruit/read`、`/fruit/delete` 這種動詞式路徑，改成資源式的 `/stations/<sno>`，用 HTTP Method 表達動作。
7. **輸入驗證**：檢查型別、經緯度範圍、車數不可超過總車格；查詢參數也有範圍檢查。錯誤訊息統一用 JSON 格式，並回傳正確的狀態碼。

**Client**

1. 所有參數都可以在網頁上輸入：常用地點、手動輸入經緯度，或用瀏覽器定位取得目前位置。
2. Server 回應會顯示在網頁的紀錄區，包含 Method、URL、Request Body、狀態碼，並依成功或失敗標示不同顏色；Console 也會輸出。
3. 提供即時概況卡片、各行政區長條圖、附近站點清單、可篩選並分頁的站點表格，每 60 秒自動刷新。
4. 點選任一站點會帶入 CRUD 表單；送出前會先在前端檢查輸入。

# 臺北市 YouBike 2.0 RESTful API

物聯網應用課後作業「Open Data RESTful API 實作」：以政府資料開放平臺
[YouBike2.0 臺北市公共自行車即時資訊](https://data.gov.tw/dataset/137993) 為資料來源，
使用 Python + Flask 實作 RESTful API Server，並提供 Swagger UI 線上文件、Python API Client 與網頁 Client。

- GitHub：<https://github.com/VincenTddos/youbike-restful-api>
- **線上展示（GitHub Pages）**：<https://vincenttddos.github.io/youbike-restful-api/>
  - 3D 城市視圖：<https://vincenttddos.github.io/youbike-restful-api/client/map.html>
  - API 文件（Swagger UI）：<https://vincenttddos.github.io/youbike-restful-api/docs/>
  - GitHub Pages 無法執行 Flask，網頁為展示模式，讀取 repo 內的 Open Data 資料檔；即時資料與 CRUD 請在本機啟動 Server。
- 本機 API 文件：啟動 Server 後開啟 <http://127.0.0.1:5000/docs>（Swagger UI，可 Try it out）

## 作業繳交項目對照

| 作業要求 | 本專案對應 |
|---|---|
| Open Data 資料檔（單一檔案） | [`data/youbike_stations.csv`](data/youbike_stations.csv)：官方 JSON 下載後轉存的 CSV，1,807 站，保留官方欄位名稱 |
| 以 Python + Flask 實作 RESTful API Server | [`rest_server.py`](rest_server.py)、[`repository.py`](repository.py)、[`sync_service.py`](sync_service.py)、[`youbike_source.py`](youbike_source.py) |
| Resource 的 CRUD | Station：`POST` / `GET` / `PUT` / `PATCH` / `DELETE` `/stations[/<sno>]` |
| API 規格與線上文件（Swagger UI） | 規格 [`docs/openapi.yaml`](docs/openapi.yaml)（OpenAPI 3.0）；Server 的 `/docs` 提供 Swagger UI，可直接 Try it out |
| Python API Client | [`api_client.py`](api_client.py)：用 `requests` 對每個端點發出 HTTP 請求，可逐一呼叫或跑完整流程 |
| 實測範例（Request / Response） | [`docs/api_examples.md`](docs/api_examples.md)：由 `api_client.py demo` 自動產生，含 Method、URL、Body、Status Code、Output |
| 其他測試方式 | [`test_rest_server.py`](test_rest_server.py)（46 項 pytest）、[`curl_test.bat`](curl_test.bat)、網頁 Client [`client/`](client/) |
| README（環境建置與執行方式） | 本文件 |
| AI 輔助開發相關設定檔 | [`CLAUDE.md`](CLAUDE.md)（Claude Code 專案設定），說明見下方「AI 輔助開發」 |

## 環境建置

需要 Python 3.10 以上。

```bash
git clone https://github.com/VincenTddos/youbike-restful-api.git
cd youbike-restful-api

python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate      # macOS / Linux

pip install -r requirements.txt
```

## 執行

```bash
python rest_server.py            # 啟動 Server (http://127.0.0.1:5000)：匯入 CSV + 每 60 秒背景同步
```

- 沒有網路時請執行 `python rest_server.py --no-sync`，只使用 CSV 裡的資料。
- 其他參數：`--csv 檔案`、`--interval 30`、`--port 5000`、`--host 0.0.0.0`
- 想重新下載最新的 Open Data：`python youbike_source.py`（覆寫 `data/youbike_stations.csv`）。

### 資料檔

| 檔案 | 說明 |
|---|---|
| `data/youbike_stations.csv` | Open Data 資料檔，納入版本控制 |
| `data/youbike_live.csv` | Server 每次同步後寫出的最新快照，不納入版本控制 |
| `data/youbike_sample.csv` | 86 站範例，自動化測試使用 |

Server 啟動時依序找 `youbike_live.csv` → `youbike_stations.csv` → `youbike_sample.csv`，用第一個存在的檔案。

## API 文件（Swagger UI）

Server 啟動後開啟 <http://127.0.0.1:5000/docs>，可以看到所有端點、參數、Request / Response 格式與範例，
按「Try it out」→「Execute」就能直接對 Server 送出請求。原始規格檔在 [`docs/openapi.yaml`](docs/openapi.yaml)，
也可以從 <http://127.0.0.1:5000/openapi.yaml> 取得，或貼到 <https://editor.swagger.io> 檢視。

`test_openapi_covers_all_routes` 測試會比對規格檔與 Server 的實際路由，確保文件沒有漏掉任何端點。

## Python API Client

先在另一個視窗啟動 Server，再執行：

```bash
python api_client.py demo                                   # 跑完整實測流程：查詢 → CRUD → 錯誤處理，共 18 個請求
python api_client.py demo --markdown docs/api_examples.md   # 同時輸出 Markdown 實測紀錄

python api_client.py list --area 大安區 --min-rent 5 --sort -available_rent --limit 3
python api_client.py get 500101001
python api_client.py nearby 25.0478 121.5170 --r 300 --need rent
python api_client.py create "{\"sno\":\"900000001\",\"name\":\"測試站\",\"area\":\"中正區\",\"lat\":25.04,\"lng\":121.52,\"total\":20,\"available_rent\":5,\"available_return\":15}"
python api_client.py update 900000001 "{\"available_rent\":3}"
python api_client.py delete 900000001
python api_client.py areas        # 其他：stats、sync-status、sync、info、replace
```

每個請求都會印出 Method、URL、Request Body、Status Code 與 Response。
Server 不在預設位址時加上 `--base-url http://127.0.0.1:5001`。

實測結果：[`docs/api_examples.md`](docs/api_examples.md)。

## 網頁 Client

直接用瀏覽器開啟（不需要另外架站）：

| 頁面 | 內容 |
|---|---|
| `client/index.html` | API 管理介面：即時概況、附近站點、站點 CRUD 表單、分頁查詢、Server 回應紀錄 |
| `client/map.html` | 3D 城市視圖（three.js）：每站一根發光柱，高度 = 可借車輛 / 可還空位，沒車的站地面紅色脈衝；附近站點、一鍵 Google Maps 導航 |
| `client/map2d.html` | 平面地圖版（Leaflet） |

Server 不在 `localhost:5000` 時，可在頁面上的「設定」修改 API Host，或加上網址參數 `map.html?api=http://127.0.0.1:5001/`。
連不到 API Server 時，地圖會自動切換成展示模式（`client/static-api.js`），改讀 `data/youbike_stations.csv`。

## 自動化測試

```bash
pytest -v        # 46 項，不需要網路，也不需要先啟動 Server
```

涵蓋 CSV 匯入、CRUD、輸入驗證、查詢與排序、附近站點、統計、同步、Swagger 文件，
以及 Python API Client 透過真正的 HTTP 跑完整 CRUD 流程。

## 檔案結構

| 檔案 | 職責 |
|---|---|
| `youbike_source.py` | 下載官方 JSON、欄位轉換、CSV 讀寫 |
| `repository.py` | 資料存取層：`StationRepository` 抽象介面與 `DictStationRepository` 實作 |
| `sync_service.py` | 背景同步執行緒，定期抓官方資料並更新 |
| `rest_server.py` | Flask 路由、輸入驗證、Swagger UI |
| `api_client.py` | Python API Client |
| `docs/openapi.yaml` | OpenAPI 3.0 規格 |
| `docs/api_examples.md` | API 實測範例 |
| `client/` | 網頁 Client：`index.html` API 管理介面、`map.html` 3D 城市視圖、`map2d.html` 平面地圖 |
| `index.html`、`docs/index.html` | GitHub Pages 首頁與靜態版 Swagger UI |
| `test_rest_server.py` | 46 項自動化測試 |
| `curl_test.bat` | curl 測試腳本（Windows） |
| `CLAUDE.md` | AI 輔助開發工具（Claude Code）的專案設定 |

## 資料流

```
政府開放資料 (JSON, 每分鐘更新)
      │  sync_service 每 60 秒抓取 (背景執行緒)
      ▼
normalize() 欄位轉換 ──► DictStationRepository (記憶體, Lock 保護) ◄── Flask 路由 ◄── API Client / 網頁 / curl
      ▲                         │
 啟動時 load_csv()          每次同步後 save_csv()
      │                         ▼
 data/youbike_stations.csv   data/youbike_live.csv
```

## API

完整規格請看 Swagger UI（`/docs`）。

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
| API 文件 | GET | `/docs`、`/openapi.yaml` |

`sort` 可用 `sno`、`name`、`area`、`total`、`available_rent`、`available_return`，前面加 `-` 代表遞減。

站點欄位：`sno`、`name`、`area`、`address`、`lat`、`lng`、`total`、`available_rent`、`available_return`、`active`、`updated_at`、`source`（`official` 或 `custom`）。

狀態碼：200、201 新增成功、400 輸入錯誤、404 找不到、409 編號重複、502 同步失敗。

## AI 輔助開發

本專案使用 **Claude Code**（Anthropic，VS Code 擴充套件）輔助開發。

- **設定檔**：[`CLAUDE.md`](CLAUDE.md) 是 Claude Code 每次啟動時會讀取的專案說明，記錄架構、執行與測試指令、程式慣例，
  讓 AI 產生的程式碼和既有程式風格一致（例如 OpenAPI 規格必須和路由同步、前端一律用 `textContent` 避免 XSS）。
- **AI 協助的工作**：
  - 依資料主題設計 API：資源式路由、查詢參數、狀態碼與錯誤格式
  - 撰寫 OpenAPI 3.0 規格與 Swagger UI 頁面
  - 實作 Python API Client 與實測流程，自動產生 `docs/api_examples.md`
  - 撰寫自動化測試，包含「規格涵蓋所有路由」的檢查
  - 網頁 Client：3D 城市視圖（three.js）與平面地圖（Leaflet）
- **人工把關**：AI 產生的程式碼都經過 `pytest` 與實際啟動 Server 測試後才提交。

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

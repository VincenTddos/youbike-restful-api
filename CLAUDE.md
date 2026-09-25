# CLAUDE.md

Claude Code 在這個專案工作時的說明。臺北市 YouBike 2.0 Open Data RESTful API（Python + Flask），物聯網應用課程作業。

## 常用指令

```bash
pip install -r requirements.txt
python rest_server.py                 # http://127.0.0.1:5000，Swagger UI 在 /docs
python rest_server.py --no-sync       # 離線，只用 CSV
python youbike_source.py              # 重新下載 Open Data → data/youbike_stations.csv
python api_client.py demo --markdown docs/api_examples.md   # 需先啟動 Server；重新產生實測範例
pytest -q                             # 不需要網路，也不需要先啟動 Server
```

## 架構

- `youbike_source.py`：下載官方 JSON、`normalize()` 官方欄位 → API 欄位、CSV 讀寫。CSV 保留官方欄位名稱。
- `repository.py`：`StationRepository` 抽象介面 + `DictStationRepository`（記憶體 dict，`RLock` 保護）。新的儲存方式（SQLite、MariaDB）請實作同一個介面，不要讓路由直接碰資料。
- `sync_service.py`：背景執行緒定期同步官方資料；`source == 'custom'` 的站點不會被覆蓋。
- `rest_server.py`：Flask 路由與輸入驗證，只做「解析請求 → 呼叫 repository → 回傳 JSON」。`create_app(repo, sync)` 可注入假資料，測試靠這個。
- `api_client.py`：Python API Client（requests）。
- `docs/openapi.yaml`：OpenAPI 3.0 規格，`/docs` 用 Swagger UI 顯示。
- `client/`：純前端網頁（不需建置）。`map.html` + `map3d.js` 是 three.js 3D 視圖，`map2d.*` 是 Leaflet 平面地圖，`index.html` + `app.js` 是 CRUD 管理介面。

## 資料檔

- `data/youbike_stations.csv`：作業要求的 Open Data 資料檔，納入版本控制。
- `data/youbike_live.csv`：Server 同步後寫出的快照，已列入 `.gitignore`，不要提交。
- `data/youbike_sample.csv`：86 站範例，測試用，不要改內容（測試依賴它）。

## 慣例

- 新增或修改 API 路由時，**同一次修改要更新 `docs/openapi.yaml`**；`test_openapi_covers_all_routes` 會比對兩者。
- 錯誤一律回傳 `{"result": "error", "message": ...}` 與正確狀態碼（400 / 404 / 409 / 502），透過 `ValidationError` 等 `ApiError` 子類別丟出。
- 註解、文件、使用者看到的訊息用繁體中文；程式識別字用英文。
- 前端寫入 DOM 一律用 `textContent`（見 `el()`），不要用 `innerHTML` 放資料，避免 XSS。
- 前端外部資源只從 cdnjs / jsDelivr 載入並加上 SRI（`integrity`）；網頁要能直接用 `file://` 開啟，所以 JS 不要用 `type="module"` 載入本地檔案。
- 不要加入 emoji 當圖示，使用 SVG。
- 修改後先跑 `pytest -q`，再實際啟動 Server 確認。

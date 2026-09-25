# API 實測範例

由 `python api_client.py demo --markdown docs/api_examples.md` 自動產生，測試時間 2026-09-25 21:45:54，Server：`http://127.0.0.1:5001`。

回應中的清單只列前 3 筆（標示「略」）。

| # | 情境 | Method | URL Path | Status |
|---|---|---|---|---|
| 1 | API 資訊 | `GET` | `/` | 200 |
| 2 | 查詢站點：大安區、可借 ≥ 5、依可借數遞減、取 3 筆 | `GET` | `/stations?area=大安區&min_rent=5&sort=-available_rent&limit=3` | 200 |
| 3 | 關鍵字搜尋：「捷運」、第 2 頁（每頁 2 筆） | `GET` | `/stations?q=捷運&limit=2&offset=2` | 200 |
| 4 | 查詢單一站點 | `GET` | `/stations/500101100` | 200 |
| 5 | 附近站點：臺北車站 300 m 內有車可借的站 | `GET` | `/stations/nearby?lat=25.0478&lng=121.517&r=300&limit=3&need=rent` | 200 |
| 6 | 行政區列表 | `GET` | `/areas` | 200 |
| 7 | 統計（快沒車門檻 = 1） | `GET` | `/stats?low=1` | 200 |
| 8 | Create：新增站點 | `POST` | `/stations` | 201 |
| 9 | Read：確認新增結果 | `GET` | `/stations/900000001` | 200 |
| 10 | Update：PUT 整筆改換 | `PUT` | `/stations/900000001` | 200 |
| 11 | Update：PATCH 部份更新 | `PATCH` | `/stations/900000001` | 200 |
| 12 | Delete：刪除站點 | `DELETE` | `/stations/900000001` | 200 |
| 13 | Read：刪除後再查詢 → 404 | `GET` | `/stations/900000001` | 404 |
| 14 | 錯誤處理：缺少必填欄位 → 400 | `POST` | `/stations` | 400 |
| 15 | 錯誤處理：站點編號重複 → 409 | `POST` | `/stations` | 409 |
| 16 | 錯誤處理：可借數超過總車格 → 400 | `PATCH` | `/stations/500101100` | 400 |
| 17 | 錯誤處理：座標超出範圍 → 400 | `GET` | `/stations/nearby?lat=0&lng=0` | 400 |
| 18 | 背景同步狀態 | `GET` | `/sync/status` | 200 |

## 1. API 資訊

**Request**

```http
GET /
```

**Response** — Status `200`

```json
{
  "name": "Taipei YouBike 2.0 RESTful API",
  "data_source": "https://data.gov.tw/dataset/137993",
  "csv_loaded": "youbike_stations.csv",
  "stations": 1807,
  "docs": "/docs",
  "endpoints": {
    "GET /stations": "查詢站點 (area, q, min_rent, min_return, active, sort, limit, offset)",
    "GET /stations/<sno>": "查詢單一站點",
    "POST /stations": "新增站點",
    "PUT /stations/<sno>": "整筆改換站點",
    "PATCH /stations/<sno>": "部份更新站點",
    "DELETE /stations/<sno>": "刪除站點",
    "GET /stations/nearby": "附近站點 (lat, lng, r, limit, need=rent|return)",
    "GET /areas": "行政區列表",
    "GET /stats": "統計 (總覽、各區、快沒車、已滿位)",
    "GET /sync/status": "背景同步狀態",
    "POST /sync": "立即同步一次官方資料",
    "GET /docs": "Swagger UI 線上 API 文件",
    "GET /openapi.yaml": "OpenAPI 3.0 規格檔"
  }
}
```

## 2. 查詢站點：大安區、可借 ≥ 5、依可借數遞減、取 3 筆

**Request**

```http
GET /stations?area=大安區&min_rent=5&sort=-available_rent&limit=3
```

**Response** — Status `200`

```json
{
  "total": 139,
  "count": 3,
  "limit": 3,
  "offset": 0,
  "items": [
    {
      "sno": "500101027",
      "name": "臺灣科技大學後門",
      "area": "大安區",
      "address": "基隆路四段41巷68弄臺科帆船大樓旁",
      "lat": 25.01182,
      "lng": 121.54165,
      "total": 99,
      "available_rent": 62,
      "available_return": 37,
      "active": true,
      "updated_at": "2026-09-25 21:43:03",
      "source": "official"
    },
    {
      "sno": "500101144",
      "name": "捷運大安森林公園站(2號出口)",
      "area": "大安區",
      "address": "捷運大安森林公園站(2號出口)西側",
      "lat": 25.03332,
      "lng": 121.53435,
      "total": 69,
      "available_rent": 40,
      "available_return": 27,
      "active": true,
      "updated_at": "2026-09-25 21:43:03",
      "source": "official"
    },
    {
      "sno": "500101032",
      "name": "臺大男一舍前",
      "area": "大安區",
      "address": "長興街50號西北側",
      "lat": 25.01637,
      "lng": 121.54535,
      "total": 61,
      "available_rent": 35,
      "available_return": 26,
      "active": true,
      "updated_at": "2026-09-25 21:43:03",
      "source": "official"
    }
  ]
}
```

## 3. 關鍵字搜尋：「捷運」、第 2 頁（每頁 2 筆）

**Request**

```http
GET /stations?q=捷運&limit=2&offset=2
```

**Response** — Status `200`

```json
{
  "total": 200,
  "count": 2,
  "limit": 2,
  "offset": 2,
  "items": [
    {
      "sno": "500101100",
      "name": "捷運麟光站(2號出口)",
      "area": "大安區",
      "address": "和平東路三段420號東北側",
      "lat": 25.0181,
      "lng": 121.55929,
      "total": 69,
      "available_rent": 9,
      "available_return": 60,
      "active": true,
      "updated_at": "2026-09-25 21:43:03",
      "source": "official"
    },
    {
      "sno": "500101101",
      "name": "捷運六張犁站",
      "area": "大安區",
      "address": "和平東路三段410號",
      "lat": 25.02397,
      "lng": 121.55266,
      "total": 64,
      "available_rent": 9,
      "available_return": 54,
      "active": true,
      "updated_at": "2026-09-25 21:43:03",
      "source": "official"
    }
  ]
}
```

## 4. 查詢單一站點

**Request**

```http
GET /stations/500101100
```

**Response** — Status `200`

```json
{
  "sno": "500101100",
  "name": "捷運麟光站(2號出口)",
  "area": "大安區",
  "address": "和平東路三段420號東北側",
  "lat": 25.0181,
  "lng": 121.55929,
  "total": 69,
  "available_rent": 9,
  "available_return": 60,
  "active": true,
  "updated_at": "2026-09-25 21:43:03",
  "source": "official"
}
```

## 5. 附近站點：臺北車站 300 m 內有車可借的站

**Request**

```http
GET /stations/nearby?lat=25.0478&lng=121.517&r=300&limit=3&need=rent
```

**Response** — Status `200`

```json
{
  "center": {
    "lat": 25.0478,
    "lng": 121.517
  },
  "radius_m": 300,
  "need": "rent",
  "count": 3,
  "items": [
    {
      "sno": "500103059",
      "name": "承德鄭州路口(市民高架下)",
      "area": "大同區",
      "address": "承德路一段/鄭州路口(市民高架下)",
      "lat": 25.04879,
      "lng": 121.51626,
      "total": 38,
      "available_rent": 27,
      "available_return": 11,
      "active": true,
      "updated_at": "2026-09-25 21:43:03",
      "source": "official",
      "distance_m": 133
    },
    {
      "sno": "500106080",
      "name": "捷運臺北車站(M2出口)",
      "area": "中正區",
      "address": "市民大道一段168號旁",
      "lat": 25.04821,
      "lng": 121.51903,
      "total": 20,
      "available_rent": 10,
      "available_return": 8,
      "active": true,
      "updated_at": "2026-09-25 21:43:03",
      "source": "official",
      "distance_m": 210
    },
    {
      "sno": "500103051",
      "name": "臺北轉運站(華陰街)",
      "area": "大同區",
      "address": "華陰街45號(對面)",
      "lat": 25.04937,
      "lng": 121.51914,
      "total": 20,
      "available_rent": 17,
      "available_return": 1,
      "active": true,
      "updated_at": "2026-09-25 21:43:03",
      "source": "official",
      "distance_m": 277
    }
  ]
}
```

## 6. 行政區列表

**Request**

```http
GET /areas
```

**Response** — Status `200`

```json
[
  {
    "area": "中山區",
    "stations": 205
  },
  {
    "area": "中正區",
    "stations": 138
  },
  {
    "area": "信義區",
    "stations": 129
  },
  "... 共 13 筆，略"
]
```

## 7. 統計（快沒車門檻 = 1）

**Request**

```http
GET /stats?low=1
```

**Response** — Status `200`

```json
{
  "summary": {
    "stations": 1807,
    "active_stations": 1780,
    "total_docks": 50669,
    "available_rent": 16234,
    "available_return": 33150,
    "low_bike_stations": 196,
    "full_stations": 18
  },
  "by_area": [
    {
      "area": "大安區",
      "stations": 213,
      "total": 6609,
      "available_rent": 1864,
      "available_return": 4613,
      "rent_ratio": 0.282
    },
    {
      "area": "中山區",
      "stations": 199,
      "total": 5432,
      "available_rent": 1780,
      "available_return": 3513,
      "rent_ratio": 0.328
    },
    {
      "area": "內湖區",
      "stations": 226,
      "total": 5425,
      "available_rent": 1654,
      "available_return": 3624,
      "rent_ratio": 0.305
    },
    "... 共 13 筆，略"
  ],
  "low_bike_threshold": 1,
  "low_bike": [
    {
      "sno": "500101005",
      "name": "辛亥復興路口西北側",
      "area": "大安區",
      "total": 16,
      "available_rent": 0,
      "available_return": 16
    },
    {
      "sno": "500101008",
      "name": "新生南路三段52號前",
      "area": "大安區",
      "total": 17,
      "available_rent": 0,
      "available_return": 16
    },
    {
      "sno": "500101038",
      "name": "臺大社科院圖書館前",
      "area": "大安區",
      "total": 27,
      "available_rent": 0,
      "available_return": 26
    },
    "... 共 196 筆，略"
  ],
  "full": [
    {
      "sno": "500101244",
      "name": "浦城街26巷",
      "area": "大安區",
      "total": 17,
      "available_rent": 17,
      "available_return": 0
    },
    {
      "sno": "500101259",
      "name": "臺靜農人文會館",
      "area": "大安區",
      "total": 12,
      "available_rent": 12,
      "available_return": 0
    },
    {
      "sno": "500101267",
      "name": "黎和公園",
      "area": "大安區",
      "total": 15,
      "available_rent": 14,
      "available_return": 0
    },
    "... 共 18 筆，略"
  ]
}
```

## 8. Create：新增站點

**Request**

```http
POST /stations
Content-Type: application/json

{
  "sno": "900000001",
  "name": "北商大測試站",
  "area": "中正區",
  "address": "濟南路一段321號",
  "lat": 25.0421,
  "lng": 121.5256,
  "total": 20,
  "available_rent": 5,
  "available_return": 15
}
```

**Response** — Status `201`

```json
{
  "result": "inserted successfully",
  "data": {
    "sno": "900000001",
    "address": "濟南路一段321號",
    "active": true,
    "name": "北商大測試站",
    "area": "中正區",
    "lat": 25.0421,
    "lng": 121.5256,
    "total": 20,
    "available_rent": 5,
    "available_return": 15,
    "source": "custom",
    "updated_at": "2026-09-25 21:45:54"
  }
}
```

## 9. Read：確認新增結果

**Request**

```http
GET /stations/900000001
```

**Response** — Status `200`

```json
{
  "sno": "900000001",
  "address": "濟南路一段321號",
  "active": true,
  "name": "北商大測試站",
  "area": "中正區",
  "lat": 25.0421,
  "lng": 121.5256,
  "total": 20,
  "available_rent": 5,
  "available_return": 15,
  "source": "custom",
  "updated_at": "2026-09-25 21:45:54"
}
```

## 10. Update：PUT 整筆改換

**Request**

```http
PUT /stations/900000001
Content-Type: application/json

{
  "sno": "900000001",
  "name": "北商大測試站（改）",
  "area": "中正區",
  "address": "濟南路一段321號",
  "lat": 25.0421,
  "lng": 121.5256,
  "total": 30,
  "available_rent": 10,
  "available_return": 20
}
```

**Response** — Status `200`

```json
{
  "result": "replaced successfully",
  "data": {
    "sno": "900000001",
    "address": "濟南路一段321號",
    "active": true,
    "name": "北商大測試站（改）",
    "area": "中正區",
    "lat": 25.0421,
    "lng": 121.5256,
    "total": 30,
    "available_rent": 10,
    "available_return": 20,
    "source": "custom",
    "updated_at": "2026-09-25 21:45:54"
  }
}
```

## 11. Update：PATCH 部份更新

**Request**

```http
PATCH /stations/900000001
Content-Type: application/json

{
  "available_rent": 3,
  "available_return": 27
}
```

**Response** — Status `200`

```json
{
  "result": "updated successfully",
  "data": {
    "sno": "900000001",
    "address": "濟南路一段321號",
    "active": true,
    "name": "北商大測試站（改）",
    "area": "中正區",
    "lat": 25.0421,
    "lng": 121.5256,
    "total": 30,
    "available_rent": 3,
    "available_return": 27,
    "source": "custom",
    "updated_at": "2026-09-25 21:45:54"
  }
}
```

## 12. Delete：刪除站點

**Request**

```http
DELETE /stations/900000001
```

**Response** — Status `200`

```json
{
  "result": "deleted successfully"
}
```

## 13. Read：刪除後再查詢 → 404

**Request**

```http
GET /stations/900000001
```

**Response** — Status `404`

```json
{
  "result": "error",
  "message": "station not found: '900000001'"
}
```

## 14. 錯誤處理：缺少必填欄位 → 400

**Request**

```http
POST /stations
Content-Type: application/json

{
  "sno": "900000002",
  "name": "缺欄位"
}
```

**Response** — Status `400`

```json
{
  "result": "error",
  "message": "missing fields: area, lat, lng, total, available_rent, available_return"
}
```

## 15. 錯誤處理：站點編號重複 → 409

**Request**

```http
POST /stations
Content-Type: application/json

{
  "sno": "500101100",
  "name": "北商大測試站",
  "area": "中正區",
  "address": "濟南路一段321號",
  "lat": 25.0421,
  "lng": 121.5256,
  "total": 20,
  "available_rent": 5,
  "available_return": 15
}
```

**Response** — Status `409`

```json
{
  "result": "error",
  "message": "station already exists: '500101100'"
}
```

## 16. 錯誤處理：可借數超過總車格 → 400

**Request**

```http
PATCH /stations/500101100
Content-Type: application/json

{
  "available_rent": 999
}
```

**Response** — Status `400`

```json
{
  "result": "error",
  "message": "available_rent / available_return cannot exceed total"
}
```

## 17. 錯誤處理：座標超出範圍 → 400

**Request**

```http
GET /stations/nearby?lat=0&lng=0
```

**Response** — Status `400`

```json
{
  "result": "error",
  "message": "query 'lat' must be between 21.0 and 26.5"
}
```

## 18. 背景同步狀態

**Request**

```http
GET /sync/status
```

**Response** — Status `200`

```json
{
  "enabled": true,
  "interval_sec": 60,
  "last_attempt": "2026-09-25 21:44:54",
  "last_success": "2026-09-25 21:44:54",
  "last_error": null,
  "last_result": {
    "inserted": 0,
    "updated": 1807,
    "skipped_custom": 0,
    "fetched": 1807,
    "elapsed_ms": 691
  },
  "success_count": 2,
  "error_count": 0
}
```

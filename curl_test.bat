@echo off
chcp 65001 > nul
REM curl_test.bat ~ 以 curl 測試 YouBike RESTful API (Windows)
REM 請先在另一個視窗執行: python rest_server.py

set HOST=http://localhost:5000
set W=-w "\n  => HTTP %%{http_code}\n"

echo ===== 1. API 說明 =====
curl -s %W% %HOST%/

echo.
echo ===== 2. 查詢站點: 中正區、可借 5 台以上、依可借數排序、取 3 筆 =====
curl -s %W% "%HOST%/stations?area=%%E4%%B8%%AD%%E6%%AD%%A3%%E5%%8D%%80&min_rent=5&sort=-available_rent&limit=3"

echo.
echo ===== 3. 附近站點: 臺北車站 500 公尺內、要借車 =====
curl -s %W% "%HOST%/stations/nearby?lat=25.0478&lng=121.5170&r=500&need=rent&limit=3"

echo.
echo ===== 4. 行政區列表 / 統計 =====
curl -s %W% %HOST%/areas
curl -s %W% "%HOST%/stats?low=0"

echo.
echo ===== 5. 新增自建站點 =====
curl -s %W% -X POST -H "Content-Type: application/json" -d "{\"sno\":\"900000001\",\"name\":\"NTUB Test\",\"area\":\"Zhongzheng\",\"address\":\"No.321, Sec.1, Jinan Rd.\",\"lat\":25.0421,\"lng\":121.5256,\"total\":20,\"available_rent\":5,\"available_return\":15}" %HOST%/stations

echo.
echo ===== 6. 部份更新 (PATCH) =====
curl -s %W% -X PATCH -H "Content-Type: application/json" -d "{\"available_rent\":12}" %HOST%/stations/900000001

echo.
echo ===== 7. 整筆改換 (PUT) =====
curl -s %W% -X PUT -H "Content-Type: application/json" -d "{\"name\":\"NTUB Station\",\"area\":\"Zhongzheng\",\"lat\":25.0421,\"lng\":121.5256,\"total\":30,\"available_rent\":10,\"available_return\":20}" %HOST%/stations/900000001

echo.
echo ===== 8. 查詢單一站點 / 刪除 =====
curl -s %W% %HOST%/stations/900000001
curl -s %W% -X DELETE %HOST%/stations/900000001

echo.
echo ===== 9. 錯誤情境 (預期 404 / 400 / 400) =====
curl -s %W% %HOST%/stations/000
curl -s %W% "%HOST%/stations/nearby?lat=99&lng=121.5"
curl -s %W% -X PATCH -H "Content-Type: application/json" -d "{\"available_rent\":-1}" %HOST%/stations/500101001

echo.
echo ===== 10. 立即同步 / 同步狀態 =====
curl -s %W% -X POST %HOST%/sync
curl -s %W% %HOST%/sync/status
pause

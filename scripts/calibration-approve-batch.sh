# === 清70 HITL 审批批处理 ===
# 用法：以本地 admin 登录态执行（不传凭据给 AI，零信任）
# 每批 <=10，HIGH->MED->LOW，批间执行核验 SQL

# --- HIGH (10) ---

# [批 1] HIGH 1-10
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/f45d379d-65ef-4879-8f7e-051e13c0aeda/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/d10dedd8-73fe-4cc4-9bdc-6a093299f913/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/32856bd8-4ea9-4332-92a3-bddf9fe8af38/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/72576ee9-d42c-41c8-a116-ec8b31ca4d91/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/2e9315c0-6419-4f8b-9ff6-f731e74d57a2/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/a0226933-7e1f-4835-8058-56a5b75ba75e/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/49357203-ef3a-4acf-9768-06e41180ee10/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/bb18d50e-14aa-46ec-b9b7-232506e4f353/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/0107dfaa-7d33-4c02-bbca-66d1aea196d0/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/06d49cc3-fa7c-4e26-adda-062f3e6d3e08/approve" -H "Authorization: Bearer $TOKEN"
# 批 1 核验:
psql -U agent2b -h localhost -p 5433 -d crm_native -c "SELECT status,count(*) FROM crm.calibration_patch GROUP BY status"

# --- MEDIUM (32) ---

# [批 2] MEDIUM 1-10
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/0cca783f-337f-4fda-8018-44b1e640fdd2/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/f79a41c4-4dc8-4260-96ab-1eec57ab6c02/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/c57f00b5-53f0-40ae-9a5a-3a0dbd77a153/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/600779bb-5afe-446f-93ad-36de515254b9/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/cf998a58-4a2d-411d-9e4c-b1c1f3338b82/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/25bf403f-2e35-4c22-b495-68d586075022/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/3818497d-d998-422e-ad9c-8409f2a55368/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/8a845232-609a-4b1a-9cd0-477c71b7cb4e/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/709c8029-19b5-4fb3-8b0a-e28831a3c02e/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/b618928b-f51c-4247-918f-e29993a6ef0c/approve" -H "Authorization: Bearer $TOKEN"
# 批 2 核验:
psql -U agent2b -h localhost -p 5433 -d crm_native -c "SELECT status,count(*) FROM crm.calibration_patch GROUP BY status"

# [批 3] MEDIUM 11-20
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/209f99f4-a127-4e9a-af9d-5eb4bc40e222/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/5b7e6874-0aa9-4a21-88ea-83b81ba93416/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/5ce2d136-2674-48a4-82a4-d2f0602de631/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/c00baefc-83d6-4437-831a-e152dea2493a/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/87aacfce-1600-4705-96a0-373e4bc1bd9f/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/ac37cc77-d791-4ee9-bf15-e1285c452be2/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/4264fe4f-fb36-4202-812b-5cd369a379a0/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/5d352f40-08ab-4e7e-9301-6efc5f7b5fe8/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/bddee2ca-8fb6-48c6-a4f0-728af974d15d/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/b2a2d547-3884-48fe-b381-1f46ba4488ec/approve" -H "Authorization: Bearer $TOKEN"
# 批 3 核验:
psql -U agent2b -h localhost -p 5433 -d crm_native -c "SELECT status,count(*) FROM crm.calibration_patch GROUP BY status"

# [批 4] MEDIUM 21-30
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/6419b4f8-87a1-4c35-9ea3-f365f2574d4a/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/3834cdfc-2ace-438c-9790-08e3ec47cb3b/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/d2b52df2-5c19-4208-bea5-4909f15f11d8/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/5bc8aee2-da77-46f4-ad3b-404aced84f86/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/064a41e5-790d-4eb6-9e63-525918ed7458/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/57a96f91-9087-4d91-8784-9a50ecb2e00c/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/9079cb66-f518-49e1-8919-e01420caf355/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/b6bff457-251b-410c-91ce-aa2809af6f35/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/930d6a98-37d2-4cb5-8e89-e363dead8159/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/4843175a-f7be-4c68-a853-05c60c1afb48/approve" -H "Authorization: Bearer $TOKEN"
# 批 4 核验:
psql -U agent2b -h localhost -p 5433 -d crm_native -c "SELECT status,count(*) FROM crm.calibration_patch GROUP BY status"

# [批 5] MEDIUM 31-32
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/6c1012e4-b5ff-4ef1-b781-5f90498e0137/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/5a58f2ec-3a6a-49c4-b479-6f3ca81ecfaf/approve" -H "Authorization: Bearer $TOKEN"
# 批 5 核验:
psql -U agent2b -h localhost -p 5433 -d crm_native -c "SELECT status,count(*) FROM crm.calibration_patch GROUP BY status"

# --- LOW (28) ---

# [批 6] LOW 1-10
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/a03f8b53-ab8a-45e6-a770-68383be91798/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/d25bf357-3f27-480c-ba98-b304309dd930/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/92c13e9f-36e4-4a62-8a52-baa0d9b7807a/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/b2f5b3d0-d00f-4eb0-9568-44b7fd25b679/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/a5d2357e-43eb-4280-8960-de7818efc291/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/77dd797a-6d2c-4905-81dd-983964443323/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/4d090806-7c1b-43c2-9ab4-8cf66e1fe8f2/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/fa318fde-eb85-4b64-8e20-16e8fd9080d2/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/d00028e2-0ea1-40ba-b3ab-c5b3bde4c570/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/099aae2a-b34f-4b36-9797-fdde39a797e3/approve" -H "Authorization: Bearer $TOKEN"
# 批 6 核验:
psql -U agent2b -h localhost -p 5433 -d crm_native -c "SELECT status,count(*) FROM crm.calibration_patch GROUP BY status"

# [批 7] LOW 11-20
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/f31bf5c3-0db3-4e6d-b4b9-5aac9b953838/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/44a776ac-00c5-4534-9791-a9c48a1f72aa/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/df56acee-f37e-45d8-865e-de2d3f3501a0/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/b3599312-5e1d-429e-ab59-2712ec18483e/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/b521a89c-2b15-4cc2-add6-1348fe1d0b99/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/ca64d1a4-3374-430e-b269-3e3c34aa1e84/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/039bf9da-8542-4b47-9f87-8e2b1634e807/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/d6b73478-eb0c-4763-8390-b9f3275cd207/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/d60056ec-8b8e-41f6-bc6d-ec6e7c1fd7d7/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/8adb5113-5959-4978-8d8c-fdc997f86be5/approve" -H "Authorization: Bearer $TOKEN"
# 批 7 核验:
psql -U agent2b -h localhost -p 5433 -d crm_native -c "SELECT status,count(*) FROM crm.calibration_patch GROUP BY status"

# [批 8] LOW 21-28
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/e07aea1c-21af-410a-8679-3499e231dc9a/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/89039ce3-660e-4dac-b0cc-c4d3dd943322/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/2735dba0-b1d3-4888-9d24-3551625ac3f6/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/b7b839db-0871-48da-8905-528f55e69d91/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/bf8ea0af-80d9-453e-adef-4b06c6c7f207/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/3ee8032b-3904-4e6f-9409-c9f6d0411812/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/528b0e1c-b71d-4f57-9591-311f55e3d1f2/approve" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://127.0.0.1:3000/api/calibration/patches/053d4ce6-8909-4b17-bee1-c791e95e6754/approve" -H "Authorization: Bearer $TOKEN"
# 批 8 核验:
psql -U agent2b -h localhost -p 5433 -d crm_native -c "SELECT status,count(*) FROM crm.calibration_patch GROUP BY status"